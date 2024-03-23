import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import {
  Commit,
  Contributor,
  Milestone,
  Misc,
  NodeEvent,
  PublicNode,
  Repo,
} from './models';
import { IServerResponse } from './interfaces';
import { refreshCommitsAndContributors, refreshRepos } from 'cron';

const app = new Elysia()
  .use(
    cors({
      origin: [
        'https://nano.casa',
        'https://www.nano.casa',
        'https://nano.org',
      ],
    })
  )
  .get('/api/data', async () => {
    // const repos = await refreshRepos();
    // refreshCommitsAndContributors(repos);
    return {
      repos: Repo.getAll(),
      commits: Commit.activity(),
      contributors: Contributor.getAll(),
      milestones: Milestone.getAll(),
      events: Commit.latestEcosystem(),
      nodeEvents: NodeEvent.getAll(),
      misc: Misc.getAll(),
      publicNodes: PublicNode.getAll(),
    } as IServerResponse;
  })
  .get('/api/ping', () => 'pong')
  .listen(8080);

export type App = typeof app;

console.log(`Server is running at ${app.server?.hostname}:${app.server?.port}`);
