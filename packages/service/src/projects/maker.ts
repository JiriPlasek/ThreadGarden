import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CloneJob } from '@threadgarden/protocol';
import { ServiceError } from '../server/router.js';
import { expandHome, validName } from './folders.js';
import {
  createRepo,
  firstLine,
  githubStatus,
  originOf,
  repoExists,
  startClone,
  type RunResult,
  type Tools,
} from './github.js';

/** A folder Threadgarden made with New project or Clone (spec §7's record). */
export type MadeEntry = {
  path: string;
  repo: string | null;
  kind: 'new' | 'clone';
  createdAt: number;
};

export type ProjectMakerDeps = {
  tools: Tools;
  /** The db's ui state: values are JSON, and may hold anything an older build wrote. */
  store: { get(key: string): unknown; set(key: string, v: unknown): void };
  headless: boolean;
  home: string;
  /** Most recent first. */
  recentCwds: () => string[];
  requireRunnable: () => Promise<void>;
  now?: () => number;
  newId?: () => string;
};

export const CREATE_IN_KEY = 'projects.createIn';
export const MADE_KEY = 'projects.made';

/** How long a finished clone job stays readable. */
const JOB_TTL_MS = 10 * 60 * 1000;

const isMadeEntry = (v: unknown): v is MadeEntry => {
  const e = v as Partial<MadeEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.path === 'string' &&
    (e.repo === null || typeof e.repo === 'string') &&
    (e.kind === 'new' || e.kind === 'clone') &&
    typeof e.createdAt === 'number'
  );
};

const fsError = (err: unknown, what: string): ServiceError => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return new ServiceError('PERMISSION', 'Permission denied');
  }
  return new ServiceError('NOT_FOUND', `${what} doesn't exist`);
};

const alreadyThere = (name: string, createIn: string): ServiceError =>
  new ServiceError(
    'EXISTS',
    `${name} already exists in ${createIn}. Use the Existing folder tab to start there.`,
  );

/** Removes a folder this call or job made. Never fails: the error that led here matters more. */
const removeMade = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});

/** Makes new project folders (New project, Clone), remembers Create in, and records what it made. */
export class ProjectMaker {
  private readonly jobs = new Map<string, { job: CloneJob; cancel(): void }>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ProjectMakerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
  }

  private get headlessDefault(): string {
    return path.join(this.deps.home, 'threadgarden', 'projects');
  }

  createIn(): string {
    const remembered = this.deps.store.get(CREATE_IN_KEY);
    if (typeof remembered === 'string' && remembered) return remembered;
    if (this.deps.headless) return this.headlessDefault;
    const recent = this.deps.recentCwds()[0];
    return recent ? path.dirname(recent) : this.deps.home;
  }

  async create(p: {
    createIn: string;
    name: string;
    github: boolean;
  }): Promise<{ path: string; repo: string | null; problem: string | null }> {
    const t = this.deps.tools;
    // Checks: everything that can be checked runs before anything is made.
    if (!validName(p.name)) {
      throw new ServiceError(
        'INVALID_NAME',
        'Use letters, digits, dots, dashes and underscores only',
      );
    }
    await this.deps.requireRunnable();
    const place = await this.place(p.createIn);
    const target = path.join(place.dir, p.name);
    if (await this.exists(target)) throw alreadyThere(p.name, p.createIn);
    if (p.github) {
      await this.requireGithub();
      if (await repoExists(t, p.name)) {
        throw new ServiceError('REPO_EXISTS', `${p.name} already exists on GitHub`);
      }
    }

    // Make. Only a folder this call made is ever removed.
    await this.makeFolder(place, target, p.name, p.createIn);
    let created: { fullName: string; url: string } | null = null;
    let problem: string | null = null;
    try {
      const init = await t.run('git', ['init'], { cwd: target, timeoutMs: 30000 });
      if (init.code !== 0) {
        throw new ServiceError('GIT_FAILED', firstLine(init.stderr) || 'git init failed');
      }
      if (p.github) created = await createRepo(t, p.name);
    } catch (err) {
      // Once the repo exists nothing is removed: the folder belongs with it.
      if (!(err instanceof ServiceError && err.code === 'REPO_CREATED')) {
        await removeMade(target);
        throw err;
      }
      problem = err.message;
    }
    if (created) {
      const remote = await t.run('git', ['remote', 'add', '--', 'origin', created.url], {
        cwd: target,
        timeoutMs: 10000,
      });
      if (remote.code !== 0) {
        problem = `the GitHub repo was created, but connecting it failed: ${firstLine(remote.stderr) || 'git remote add failed'}`;
      }
    }

    const repo = created?.fullName ?? null;
    this.record({ path: target, repo, kind: 'new', createdAt: this.now() }, place.dir);
    return { path: target, repo, problem };
  }

  async clone(p: {
    createIn: string;
    repo: string;
  }): Promise<{ status: 'started'; job: CloneJob } | { status: 'existing'; path: string }> {
    const t = this.deps.tools;
    const [owner, name, ...rest] = p.repo.split('/');
    if (!owner || !name || rest.length > 0 || !validName(name)) {
      throw new ServiceError('INVALID_NAME', `${p.repo} is not a GitHub repository name`);
    }
    const place = await this.place(p.createIn);
    const target = path.join(place.dir, name);
    if (await this.exists(target)) {
      if ((await originOf(t, target)) === p.repo.toLowerCase()) {
        return { status: 'existing', path: target };
      }
      throw alreadyThere(name, p.createIn);
    }
    await this.deps.requireRunnable();
    await this.requireGithub();

    // git clones into the empty folder made here, so a failed or cancelled job removes only that.
    await this.makeFolder(place, target, name, p.createIn);
    const job: CloneJob = {
      jobId: this.newId(),
      state: 'running',
      repo: p.repo,
      path: target,
      error: null,
    };
    const run = startClone(t, p.repo, target);
    this.jobs.set(job.jobId, { job, cancel: run.cancel });
    void run.done.then((r) => this.finish(job, r, place.dir));
    return { status: 'started', job: { ...job } };
  }

  job(jobId: string): CloneJob {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new ServiceError('NOT_FOUND', 'No such clone');
    return { ...entry.job };
  }

  /** Stops a running clone; its folder is removed once the process is gone. */
  cancel(jobId: string): void {
    const entry = this.jobs.get(jobId);
    if (entry?.job.state !== 'running') return;
    entry.job.state = 'cancelled';
    entry.cancel();
  }

  async origins(): Promise<string[]> {
    const found = await Promise.all(
      this.deps.recentCwds().map((cwd) => originOf(this.deps.tools, cwd)),
    );
    return [...new Set(found.filter((o): o is string => o !== null))];
  }

  made(): MadeEntry[] {
    const stored = this.deps.store.get(MADE_KEY);
    return Array.isArray(stored) ? stored.filter(isMadeEntry) : [];
  }

  private async finish(job: CloneJob, r: RunResult, createIn: string): Promise<void> {
    if (job.state === 'cancelled') {
      await removeMade(job.path);
    } else if (r.code === 0) {
      job.state = 'done';
      this.record(
        { path: job.path, repo: job.repo, kind: 'clone', createdAt: this.now() },
        createIn,
      );
    } else {
      // Removed before it reads as failed, so a retry finds the place free.
      await removeMade(job.path);
      job.state = 'failed';
      job.error =
        r.stderr
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('fatal:')) ?? 'git clone failed';
    }
    setTimeout(() => this.jobs.delete(job.jobId), JOB_TTL_MS).unref?.();
  }

  private record(entry: MadeEntry, createIn: string): void {
    this.deps.store.set(MADE_KEY, [...this.made(), entry]);
    this.deps.store.set(CREATE_IN_KEY, createIn);
  }

  /** The absolute Create in, and whether it is the missing headless default, still to be made. */
  private async place(createIn: string): Promise<{ dir: string; make: boolean }> {
    const expanded = expandHome(createIn, this.deps.home);
    if (!path.isAbsolute(expanded)) {
      throw new ServiceError('NOT_FOUND', 'Type a full path, or start with ~');
    }
    const dir = path.resolve(expanded);
    let isDir: boolean;
    try {
      isDir = (await stat(dir)).isDirectory();
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing && this.deps.headless && dir === path.resolve(this.headlessDefault)) {
        return { dir, make: true };
      }
      throw fsError(err, createIn);
    }
    if (!isDir) throw new ServiceError('NOT_FOUND', `${createIn} is not a folder`);
    return { dir, make: false };
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await lstat(p);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw fsError(err, p);
    }
  }

  private async requireGithub(): Promise<void> {
    const status = await githubStatus(this.deps.tools);
    if (!status.ready) throw new ServiceError('GH_NOT_READY', status.problem ?? 'gh is not ready');
  }

  /** Makes the target (and the headless default first if needed); success means this call made it. */
  private async makeFolder(
    place: { dir: string; make: boolean },
    target: string,
    name: string,
    createIn: string,
  ): Promise<void> {
    try {
      if (place.make) await mkdir(place.dir, { recursive: true });
      await mkdir(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw alreadyThere(name, createIn);
      throw fsError(err, createIn);
    }
  }
}
