const Cron = require('croner');
const { Octokit } = require('octokit');
const mongoose = require('mongoose');
const models = require('./models');
const fetch = require('node-fetch');
require('dotenv').config();
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });
const REPOS = require('./repos.json');
mongoose.connect(process.env.DB_URL);
const createClient = require('redis').createClient;
const redis = createClient({
    url: process.env.REDIS_URL,
});

redis.on('error', (err) => console.log('Redis Client Error', err));
redis.connect();

async function rate() {
    console.log((await octo.request('GET /rate_limit')).data.resources.core);
}

async function refreshMilestones() {
    console.time('refreshed_milestones');
    const milestones = (
        await octo.request('GET /repos/nanocurrency/nano-node/milestones')
    ).data;
    const latest = milestones
        .filter(
            (m) => m.state == 'open' && m.title.toLowerCase().startsWith('v')
        )
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const normalized = latest
        .map(
            ({ title, open_issues, closed_issues, html_url }) =>
                new models.Milestone({
                    title,
                    open_issues,
                    closed_issues,
                    url: html_url,
                })
        )
        .sort((a, b) => b.title.localeCompare(a.title));
    await models.Milestone.collection.drop();
    await models.Milestone.insertMany(normalized);

    console.timeEnd('refreshed_milestones');
}

async function refreshRepos() {
    console.time('fetched_repos');
    const lastMonth = new Date(new Date().setDate(new Date().getDate() - 30));
    const lastWeek = new Date(new Date().setDate(new Date().getDate() - 7));
    let allRepos = [];

    for (let i = 0; i < REPOS.queries.length; i++) {
        let foundAll = false,
            page = 1;
        while (!foundAll) {
            const res = (
                await octo.request('GET /search/repositories', {
                    q: REPOS.queries[i],
                    per_page: 100,
                    page: page,
                })
            ).data.items;
            allRepos = [...allRepos, ...res];

            foundAll = res.length < 100;
            if (!foundAll) page++;
        }
    }

    const repoRequests = REPOS.known.map((name) =>
        octo.request(`GET /repos/${name}`).then((res) => res.data)
    );
    const knownResults = await Promise.all(repoRequests);

    allRepos = [...allRepos, ...knownResults];

    const uniqueRepos = allRepos.filter(function ({ full_name }) {
        return (
            !this.has(full_name) &&
            this.add(full_name) &&
            !REPOS.ignored.includes(full_name)
        );
    }, new Set());

    console.timeEnd('fetched_repos');
    console.time('fetched_pulls');

    for (let i = 0; i < uniqueRepos.length; i++) {
        let foundAll = false,
            page = 1;
        uniqueRepos[i].prs_30d = 0;
        uniqueRepos[i].prs_7d = 0;
        while (!foundAll) {
            let pulls = (
                await octo.request(
                    `GET /repos/${uniqueRepos[i].full_name}/pulls`,
                    { per_page: 100, page: page }
                )
            ).data;
            pulls = pulls.filter((pr) => new Date(pr.created_at) > lastMonth);
            uniqueRepos[i].prs_30d += pulls.length;
            uniqueRepos[i].prs_7d += pulls.filter(
                (pr) => new Date(pr.created_at) > lastWeek
            ).length;

            foundAll = pulls.length < 100;
            if (!foundAll) page++;
        }
    }
    console.timeEnd('fetched_pulls');

    console.time('refreshed_repos');

    const normalized = uniqueRepos.map(
        ({
            id,
            name,
            full_name,
            html_url,
            created_at,
            pushed_at,
            stargazers_count,
            owner,
            prs_30d,
            prs_7d,
            description,
        }) =>
            new models.Repo({
                id,
                name,
                full_name,
                html_url,
                created_at,
                pushed_at,
                stargazers_count,
                avatar_url: owner.avatar_url,
                prs_30d,
                prs_7d,
                description,
            })
    );
    await models.Repo.collection.drop();
    await models.Repo.collection.insertMany(normalized);

    console.timeEnd('refreshed_repos');

    return normalized;
}

async function refreshCommitsAndContributors(repos = []) {
    let allCommits = [];
    console.time('fetched_commits');
    const lastMonth = new Date(new Date().setDate(new Date().getDate() - 30));
    const lastWeek = new Date(new Date().setDate(new Date().getDate() - 7));

    for (let i = 0; i < repos.length; i++) {
        let foundAll = false,
            page = 1;

        while (!foundAll) {
            let activity = (
                await octo.request(`GET /repos/${repos[i].full_name}/commits`, {
                    per_page: 100,
                    page: page,
                    since: '2014-05-01T14:49:25Z',
                })
            ).data;
            activity = activity.map((act) => ({
                ...act,
                repo_full_name: repos[i].full_name,
                avatar_url: repos[i].avatar_url,
            }));
            allCommits = [...allCommits, ...activity];

            foundAll = activity.length < 100;
            if (!foundAll) page++;
        }
    }
    console.timeEnd('fetched_commits');

    const contributors = {};
    const reposToUpdate = {};
    const bulk = models.Repo.collection.initializeUnorderedBulkOp();

    const seen = new Set();
    allCommits = allCommits.filter((commit) => {
        const duplicateSHA = seen.has(commit.sha);
        seen.add(commit.sha);
        return !isEmpty(commit.author) && !duplicateSHA;
    });

    for (let i = 0; i < allCommits.length; i++) {
        const commit = allCommits[i];
        if (!contributors[commit.author.login]) {
            contributors[commit.author.login] = {
                avatar_url: commit.author.avatar_url,
                login: commit.author.login,
                contributions: 0,
                last_month: 0,
                repos: [],
            };
        }
        contributors[commit.author.login].contributions += 1;
        contributors[commit.author.login].repos = [
            ...contributors[commit.author.login].repos,
            commit.repo_full_name,
        ];

        if (new Date(commit.commit.author?.date) > lastMonth) {
            contributors[commit.author.login].last_month += 1;
            reposToUpdate[commit.repo_full_name] = reposToUpdate[
                commit.repo_full_name
            ] ?? { _30d: 0, _7d: 0 };
            reposToUpdate[commit.repo_full_name]._30d += 1;
            if (new Date(commit.commit.author?.date) > lastWeek)
                reposToUpdate[commit.repo_full_name]._7d += 1;
        }
    }

    Object.keys(reposToUpdate).forEach((name) => {
        bulk.find({ full_name: name }).updateOne([
            {
                $set: {
                    commits_30d: reposToUpdate[name]._30d,
                    commits_7d: reposToUpdate[name]._7d,
                },
            },
        ]);
    });

    if (bulk.length) bulk.execute();

    console.time('refreshed_commits');

    const normalizedContribs = Object.values(contributors).map(
        ({ avatar_url, login, contributions, repos, last_month }) =>
            new models.Contributor({
                avatar_url,
                login,
                contributions,
                last_month,
                repos: [...new Set(repos)],
            })
    );
    await models.Contributor.collection.drop();
    await models.Contributor.collection.insertMany(normalizedContribs);

    const normalizedCommits = allCommits.map(
        (commit) =>
            new models.Commit({
                repo_full_name: commit.repo_full_name,
                author: commit.author.login,
                date: commit.commit.author?.date,
                avatar_url: commit.avatar_url,
                message: commit.commit.message,
            })
    );
    await models.Commit.collection.drop();
    await models.Commit.collection.insertMany(normalizedCommits);

    console.timeEnd('refreshed_commits');
}

async function refreshDevList() {
    const url = '/repos/Joohansson/nanodevlist/contents/donatees';
    const devs = [];
    let devsRes = (await octo.request(`GET ${url}`)).data;
    for (let i = 0; i < devsRes.length; i++) {
        const {
            name,
            github,
            twitter,
            sponsor_link,
            nano_account,
            description,
            tags,
        } = await (await fetch(`${devsRes[i].download_url}`)).json();
        devs.push(
            new models.Profile({
                name,
                github,
                twitter,
                sponsor_link,
                nano_account,
                description,
                tags,
            })
        );
    }
    await models.Profile.collection.drop();
    await models.Profile.collection.insertMany(devs);
    return devs;
}

function isEmpty(obj) {
    for (var x in obj) {
        return false;
    }
    return true;
}

async function queryDB() {
    const data = {
        repos: await models.Repo.find({}, { _id: 0 })
            .sort({ created_at: 'asc' })
            .lean(),
        contributors: await models.Contributor.aggregate([
            {
                $project: {
                    contributions: 1,
                    last_month: 1,
                    repos_count: { $size: '$repos' },
                    repos: 1,
                    login: 1,
                    avatar_url: 1,
                    _id: 0,
                },
            },
            { $sort: { contributions: -1, repos_count: -1 } },
        ]),
        commits: await models.Commit.aggregate([
            {
                $group: {
                    _id: {
                        year: {
                            $year: {
                                $dateFromString: {
                                    dateString: '$date',
                                    format: '%Y-%m-%dT%H:%M:%SZ',
                                },
                            },
                        },
                        week: {
                            $week: {
                                $dateFromString: {
                                    dateString: '$date',
                                    format: '%Y-%m-%dT%H:%M:%SZ',
                                },
                            },
                        },
                    },
                    count: { $sum: 1 },
                },
            },
            {
                $sort: { '_id.year': 1, '_id.week': 1 },
            },
            {
                $project: {
                    date: {
                        $concat: [
                            { $toString: '$_id.year' },
                            '|',
                            { $toString: '$_id.week' },
                        ],
                    },
                    count: 1,
                    _id: 0,
                },
            },
        ]),
        milestones: await models.Milestone.find({}, { _id: 0 }).lean(),
        devList: await models.Profile.find({}, { _id: 0 }).lean(),
        events: await models.Commit.find({}, { _id: 0 })
            .sort({ date: 'desc' })
            .limit(35)
            .lean(),
    };
    return data;
}

// returns a random index weighted inversely
function getSpotlight(repos) {
    const weights = repos.map(({ stargazers_count, commits_30d, prs_30d }) => {
        const activity = commits_30d + prs_30d || 0;
        return activity / repos.length + 1 / (stargazers_count + 1);
    });

    let total = 0;
    for (let weight of weights) {
        total += weight;
    }

    let max = weights[0];
    const random = Math.random() * total;
    console.log(random, total);

    for (let index = 0; index < weights.length; index++) {
        if (random < max) {
            return repos[index];
        } else if (index === weights.length - 1) {
            return repos[weights.length - 1];
        }
        max += weights[index + 1];
    }
    return repos[Math.floor(Math.random() * items.length)];
}

const job = new Cron('10 * * * *', async () => {
    await refreshMilestones();
    const repos = await refreshRepos();
    await refreshCommitsAndContributors(repos);
    await refreshDevList();
    await redis.json.set('data', '.', await queryDB());
});

module.exports = {
    refreshCommitsAndContributors,
    refreshDevList,
    refreshMilestones,
    refreshRepos,
    rate,
    queryDB,
};
