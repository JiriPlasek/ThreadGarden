import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import type { GithubStatus, Repo } from '@threadgarden/protocol';
import { cleanEnv } from '../power/push-check.js';
import { ServiceError } from '../server/router.js';

export type RunResult = { code: number; stdout: string; stderr: string };

export type Tools = {
  /** Runs gh or git to completion (timeout in ms; kills on timeout → code -1, stderr 'timed out'). */
  run(
    cmd: 'gh' | 'git',
    args: string[],
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<RunResult>;
  /** Starts a long-running git clone; `cancel` kills it. */
  spawn(
    cmd: 'git' | 'gh',
    args: string[],
    opts: { cwd?: string },
  ): { done: Promise<RunResult>; cancel(): void };
};

/** gh and git never ask anything on a headless machine, and speak English whatever the locale. */
export const toolEnv = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(base),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
  };
  for (const k of ['GIT_ASKPASS', 'SSH_ASKPASS']) delete env[k];
  return env;
};

const NOT_FOUND: RunResult = { code: 127, stdout: '', stderr: 'command not found' };

/**
 * Kills a process and everything it started. On Windows git.exe is a launcher and the real work
 * runs in children, so killing the launcher alone leaves them running (and holding the pipes).
 */
const killTree = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined) return resolve();
    if (process.platform === 'win32') {
      // The callback fires once taskkill is done, so files git held are released by then.
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () =>
        resolve(),
      );
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    resolve();
  });

/**
 * Starts a program. `done` never rejects. `cancel` kills the process tree and settles `done`
 * once the kill has completed, without waiting on grandchildren that may still hold the output
 * pipes. After the process has exited `cancel` does nothing (its pid may belong to someone else).
 * `kill` is a seam for tests.
 */
export const spawnTool = (
  executable: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; kill?: (child: ChildProcess) => Promise<void> },
): { done: Promise<RunResult>; cancel(reason?: string): void } => {
  let child: ChildProcess | null = null;
  let settle: (r: RunResult) => void = () => {};
  let stdout = '';
  let stderr = '';
  let finished = false;
  let cancelling = false;
  const done = new Promise<RunResult>((resolve) => {
    settle = resolve;
    try {
      child = spawnProcess(executable, args, {
        cwd: opts.cwd,
        env: opts.env ?? toolEnv(),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finished = true;
      return resolve(NOT_FOUND);
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      finished = true;
      resolve(e.code === 'ENOENT' ? NOT_FOUND : { code: 1, stdout, stderr: e.message });
    });
    child.on('exit', () => {
      finished = true;
    });
    child.on('close', (code, signal) => {
      finished = true;
      if (cancelling) return; // the killed process reports its own code; cancel settles with its reason
      resolve({ code: code ?? (signal ? -1 : 1), stdout, stderr });
    });
  });
  return {
    done,
    cancel: (reason = 'cancelled') => {
      if (finished || cancelling || !child) return;
      cancelling = true;
      const c: ChildProcess = child;
      void (opts.kill ?? killTree)(c).then(() => {
        c.stdout?.destroy();
        c.stderr?.destroy();
        settle({ code: -1, stdout, stderr: reason });
      });
    },
  };
};

/** Runs a program to completion. Never rejects: a process failure is a RunResult. */
export const runTool = (
  executable: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> => {
  const job = spawnTool(executable, args, opts);
  const timer = setTimeout(() => job.cancel('timed out'), opts.timeoutMs);
  return job.done.finally(() => clearTimeout(timer));
};

export const systemTools: Tools = {
  run: (cmd, args, opts) => runTool(cmd, args, { ...opts, env: toolEnv() }),
  spawn: (cmd, args, opts) => spawnTool(cmd, args, { cwd: opts.cwd, env: toolEnv() }),
};

export const firstLine = (s: string): string =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';

export const githubStatus = async (t: Tools): Promise<GithubStatus> => {
  const r = await t.run('gh', ['auth', 'status', '--hostname', 'github.com'], {
    timeoutMs: 10000,
  });
  if (r.code === 0) {
    const login = /Logged in to github\.com account (\S+)/.exec(r.stdout + '\n' + r.stderr)?.[1];
    return { ready: true, login: login ?? null, problem: null };
  }
  const problem =
    r.code === 127
      ? 'GitHub CLI (gh) is not installed on this machine.'
      : /keyring/i.test(r.stderr)
        ? 'gh cannot read its keyring. Run gh auth login --insecure-storage on this machine (over SSH).'
        : 'Run gh auth login on this machine (over SSH).';
  return { ready: false, login: null, problem };
};

/** A failed gh call: not ready says why, otherwise the first line of what gh said. */
const ghFailure = async (t: Tools, r: RunResult): Promise<ServiceError> => {
  const status = await githubStatus(t);
  if (!status.ready) return new ServiceError('GH_NOT_READY', status.problem ?? 'gh is not ready');
  return new ServiceError('GH_FAILED', firstLine(r.stderr) || 'gh failed');
};

/** Splits output holding several JSON arrays back to back (gh --paginate) into the arrays. */
const splitArrays = (text: string): unknown[][] => {
  const arrays: unknown[][] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        const parsed: unknown = JSON.parse(text.slice(start, i + 1));
        if (Array.isArray(parsed)) arrays.push(parsed);
      }
    }
  }
  return arrays;
};

type ApiRepo = { full_name: string; private: boolean; updated_at: string; default_branch: string };

export const listRepos = async (t: Tools): Promise<Repo[]> => {
  const r = await t.run(
    'gh',
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
    ],
    { timeoutMs: 60000 },
  );
  if (r.code !== 0) throw await ghFailure(t, r);
  let items: ApiRepo[];
  try {
    items = splitArrays(r.stdout).flat() as ApiRepo[];
  } catch {
    throw new ServiceError('GH_FAILED', 'gh returned something unreadable');
  }
  return items
    .map((x) => ({
      fullName: x.full_name,
      private: x.private,
      updatedAt: Date.parse(x.updated_at),
      defaultBranch: x.default_branch,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const repoExists = async (t: Tools, fullNameOrName: string): Promise<boolean> =>
  (
    await t.run('gh', ['repo', 'view', '--json', 'name', '--', fullNameOrName], {
      timeoutMs: 30000,
    })
  ).code === 0;

export const createRepo = async (
  t: Tools,
  name: string,
): Promise<{ fullName: string; url: string }> => {
  const created = await t.run('gh', ['repo', 'create', '--private', '--', name], {
    timeoutMs: 30000,
  });
  if (created.code !== 0) {
    if (/already exists/i.test(created.stderr))
      throw new ServiceError('REPO_EXISTS', `${name} already exists on GitHub`);
    throw await ghFailure(t, created);
  }
  const view = await t.run('gh', ['repo', 'view', '--json', 'nameWithOwner,url', '--', name], {
    timeoutMs: 30000,
  });
  // The repo exists from here on: a failure says so, so the caller keeps what it made.
  const createdBut = (why: string): ServiceError =>
    new ServiceError(
      'REPO_CREATED',
      `the GitHub repo was created, but reading its address failed: ${why}`,
    );
  if (view.code !== 0) throw createdBut(firstLine(view.stderr) || 'gh failed');
  try {
    const parsed = JSON.parse(view.stdout) as { nameWithOwner: string; url: string };
    return { fullName: parsed.nameWithOwner, url: parsed.url };
  } catch {
    throw createdBut('gh returned something unreadable');
  }
};

/** Clones over https; the credential helper comes from `gh auth setup-git` (docs/remote-machines.md). */
export const startClone = (
  t: Tools,
  fullName: string,
  target: string,
): { done: Promise<RunResult>; cancel(): void } =>
  t.spawn(
    'git',
    ['clone', '--origin', 'origin', '--', `https://github.com/${fullName}.git`, target],
    {},
  );

/**
 * Lower-case owner/name of a github.com origin (https or ssh), else null. Only `dir`'s own:
 * git walks up to a repo above, so a plain folder inside one has none. `--show-prefix` is
 * empty only at the top of a work tree, and needs no path comparing (case, slashes, links).
 */
export const originOf = async (t: Tools, dir: string): Promise<string | null> => {
  const top = await t.run('git', ['rev-parse', '--show-prefix'], { cwd: dir, timeoutMs: 10000 });
  if (top.code !== 0 || top.stdout.trim() !== '') return null;
  const r = await t.run('git', ['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs: 10000 });
  if (r.code !== 0) return null;
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      r.stdout.trim(),
    );
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};
