/**
 * The project-related service methods (folders, create, clone, GitHub) as plain
 * calls on one machine's client, so components and tests need not know the wire shape.
 */
import {
  MOVE_CAPABILITY,
  PROJECTS_CAPABILITY,
  ProjectNameSchema,
  type CloneJob,
  type FolderListing,
  type GithubStatus,
  type Params,
  type Repo,
  type Result,
} from '@threadgarden/protocol';
import type { Api } from './state/api';
import type { MachineEntry } from './state/machines.svelte';

/** Ruling P9: what the New project tab says under a name the pattern or length refuses. */
export const NAME_HINT = 'Letters, digits, . _ - only (at most 100)';
const TRAILING_DOT = "A name can't end with '.'";

/**
 * Why `name` can't be a project's name, in the dialog's words; null when it can.
 * Windows device names are known only to the service, which refuses them itself.
 */
export const nameProblem = (name: string): string | null => {
  const checked = ProjectNameSchema.safeParse(name);
  if (checked.success) return null;
  const said = checked.error.issues.map((i) => i.message);
  return said.every((m) => m === TRAILING_DOT) ? TRAILING_DOT : NAME_HINT;
};

/** The machine's service can browse folders and create or clone projects. */
export const supportsProjects = (m: MachineEntry | undefined): boolean =>
  !!m?.info?.capabilities.includes(PROJECTS_CAPABILITY);

/** The machine's service can export and import a chat (Move to…). */
export const supportsMove = (m: MachineEntry | undefined): boolean =>
  !!m?.info?.capabilities.includes(MOVE_CAPABILITY);

export const projectsApi = (api: Api) => ({
  list: (path: string): Promise<FolderListing> => api.request('folders.list', { path }),
  complete: async (partial: string): Promise<string[]> =>
    (await api.request('folders.complete', { partial })).matches,
  makeFolder: async (parent: string, name: string): Promise<string> =>
    (await api.request('folders.create', { parent, name })).path,
  createIn: async (): Promise<string> => (await api.request('projects.createIn', {})).path,
  create: (p: Params<'projects.create'>): Promise<Result<'projects.create'>> =>
    api.request('projects.create', p),
  clone: (p: Params<'projects.clone'>): Promise<Result<'projects.clone'>> =>
    api.request('projects.clone', p),
  job: (jobId: string): Promise<CloneJob> => api.request('projects.job', { jobId }),
  cancel: async (jobId: string): Promise<void> => {
    await api.request('projects.cancel', { jobId });
  },
  origins: async (): Promise<string[]> => (await api.request('projects.origins', {})).repos,
  githubStatus: (): Promise<GithubStatus> => api.request('github.status', {}),
  repos: async (): Promise<Repo[]> => (await api.request('github.repos', {})).repos,
});

export type ProjectsApi = ReturnType<typeof projectsApi>;
