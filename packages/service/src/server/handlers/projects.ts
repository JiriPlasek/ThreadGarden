/** Router handlers for folders, new/cloned projects and GitHub (protocol 7). */
import { completeFolder, listFolders, makeFolder } from '../../projects/folders.js';
import { githubStatus, listRepos, type Tools } from '../../projects/github.js';
import type { ProjectMaker } from '../../projects/maker.js';
import type { Router } from '../router.js';

export const registerProjectHandlers = (
  router: Router,
  deps: { maker: ProjectMaker; tools: Tools; home: string },
): void => {
  const { maker, tools, home } = deps;
  router.register('folders.list', async (p) => listFolders(p.path, home));
  router.register('folders.complete', async (p) => ({
    matches: await completeFolder(p.partial, home),
  }));
  router.register('folders.create', async (p) => ({
    path: await makeFolder(p.parent, p.name, home),
  }));
  router.register('projects.createIn', async () => ({ path: maker.createIn() }));
  router.register('projects.create', async (p) => maker.create(p));
  router.register('projects.clone', async (p) => maker.clone(p));
  router.register('projects.job', async (p) => maker.job(p.jobId));
  router.register('projects.cancel', async (p) => {
    maker.cancel(p.jobId);
    return {};
  });
  router.register('projects.origins', async () => ({ repos: await maker.origins() }));
  router.register('github.status', async () => githubStatus(tools));
  router.register('github.repos', async () => ({ repos: await listRepos(tools) }));
};
