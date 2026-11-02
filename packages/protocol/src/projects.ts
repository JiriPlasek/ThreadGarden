import { z } from 'zod';

/** Advertised in `hello` by a service that can browse folders, create and clone projects. */
export const PROJECTS_CAPABILITY = 'projects';

/** What a project folder may be called: one path segment, nothing a shell or a path would reinterpret. */
export const PROJECT_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export const ProjectNameSchema = z
  .string()
  .refine((name) => PROJECT_NAME.test(name) && name !== '.' && name !== '..', {
    message: 'Use letters, digits, dots, dashes and underscores only (up to 100)',
  })
  // Windows drops a trailing dot, so `plant.` would name the existing `plant`.
  .refine((name) => !name.endsWith('.'), { message: "A name can't end with '.'" });

export const FolderEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** The folder is a git repository (has a `.git`). */
  git: z.boolean(),
});
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

export const FolderListingSchema = z.object({
  path: z.string(),
  /** The folder above, `null` at a root. */
  parent: z.string().nullable(),
  folders: z.array(FolderEntrySchema),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

/** Whether this machine's `gh` can create and clone repositories right now. */
export const GithubStatusSchema = z.object({
  ready: z.boolean(),
  login: z.string().nullable(),
  /** A short plain reason when not ready; never anything secret. */
  problem: z.string().nullable(),
});
export type GithubStatus = z.infer<typeof GithubStatusSchema>;

export const RepoSchema = z.object({
  fullName: z.string(),
  private: z.boolean(),
  updatedAt: z.number(),
  defaultBranch: z.string(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const CloneJobSchema = z.object({
  jobId: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  repo: z.string(),
  path: z.string(),
  error: z.string().nullable(),
});
export type CloneJob = z.infer<typeof CloneJobSchema>;
