import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_IN_KEY,
  MADE_KEY,
  ProjectMaker,
  type ProjectMakerDeps,
} from '../../src/projects/maker.js';
import { ServiceError } from '../../src/server/router.js';
import { fakeTools, type Reply } from './fake-tools.js';

let home: string;
let code: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'threadgarden-maker-'));
  code = path.join(home, 'code');
  mkdirSync(code);
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

const AUTH = /^auth status/;
const ghReady: Reply = {
  cmd: 'gh',
  match: AUTH,
  result: { stdout: 'Logged in to github.com account me' },
};
const ghNotReady: Reply = { cmd: 'gh', match: AUTH, result: { code: 1, stderr: 'not logged in' } };
const repoFree: Reply = { cmd: 'gh', match: /^repo view --json name --/, result: { code: 1 } };
const repoTaken: Reply = { cmd: 'gh', match: /^repo view --json name --/, result: {} };
const repoCreated: Reply = { cmd: 'gh', match: /^repo create/, result: {} };
const repoAddress: Reply = {
  cmd: 'gh',
  match: /^repo view --json nameWithOwner,url/,
  result: { stdout: '{"nameWithOwner":"me/plant","url":"https://github.com/me/plant"}' },
};
const remoteAdded: Reply = { cmd: 'git', match: /^remote add/, result: {} };
/** `git init` that makes `.git` like the real one. */
const gitInit: Reply = {
  cmd: 'git',
  match: /^init/,
  result: (call) => {
    mkdirSync(path.join(call.cwd!, '.git'));
    return {};
  },
};
const originIs = (url: string): Reply => ({
  cmd: 'git',
  match: /^remote get-url origin/,
  result: { stdout: url + '\n' },
});

const setup = (
  o: {
    replies?: Reply[];
    headless?: boolean;
    recent?: string[];
    stored?: Record<string, unknown>;
  } = {},
) => {
  const tools = fakeTools(o.replies ?? []);
  const values = new Map<string, unknown>(Object.entries(o.stored ?? {}));
  const store = {
    get: (k: string) => values.get(k),
    set: (k: string, v: unknown) => values.set(k, v),
  };
  const requireRunnable = vi.fn(async () => {});
  let id = 0;
  const deps: ProjectMakerDeps = {
    tools,
    store,
    headless: o.headless ?? false,
    home,
    recentCwds: () => o.recent ?? [],
    requireRunnable,
    now: () => 1000,
    newId: () => `job-${++id}`,
  };
  return { maker: new ProjectMaker(deps), tools, values, requireRunnable };
};

const failure = async (run: () => Promise<unknown>): Promise<ServiceError> => {
  try {
    await run();
  } catch (err) {
    return err as ServiceError;
  }
  throw new Error('expected a failure');
};

const ran = (tools: ReturnType<typeof fakeTools>): string[] =>
  tools.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);

describe('createIn', () => {
  it('createIn defaults: headless ~/threadgarden/projects, desktop the parent of the most recent project, else home; remembers the last used', async () => {
    expect(setup({ headless: true }).maker.createIn()).toBe(
      path.join(home, 'threadgarden', 'projects'),
    );
    const recent = [path.join(code, 'a'), path.join(home, 'elsewhere', 'b')];
    expect(setup({ recent }).maker.createIn()).toBe(code);
    expect(setup().maker.createIn()).toBe(home);
    expect(setup({ stored: { [CREATE_IN_KEY]: '/last/used' } }).maker.createIn()).toBe(
      '/last/used',
    );
    // Garbage in the store is ignored.
    expect(setup({ headless: true, stored: { [CREATE_IN_KEY]: 42 } }).maker.createIn()).toBe(
      path.join(home, 'threadgarden', 'projects'),
    );
  });
});

describe('create', () => {
  it('create makes the folder and git init and records it', async () => {
    const { maker, tools, requireRunnable } = setup({ replies: [gitInit] });
    const target = path.join(code, 'plant');
    expect(await maker.create({ createIn: '~/code', name: 'plant', github: false })).toEqual({
      path: target,
      repo: null,
      problem: null,
    });
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(tools.calls).toEqual([{ cmd: 'git', args: ['init'], cwd: target, timeoutMs: 30000 }]);
    expect(requireRunnable).toHaveBeenCalledOnce();
    expect(maker.made()).toEqual([{ path: target, repo: null, kind: 'new', createdAt: 1000 }]);
    expect(maker.createIn()).toBe(code);
  });

  it('with github: creates the private repo and sets it as origin', async () => {
    const { maker, tools } = setup({
      replies: [ghReady, repoFree, gitInit, repoCreated, repoAddress, remoteAdded],
    });
    const target = path.join(code, 'plant');
    expect(await maker.create({ createIn: code, name: 'plant', github: true })).toEqual({
      path: target,
      repo: 'me/plant',
      problem: null,
    });
    expect(tools.calls.at(-1)).toEqual({
      cmd: 'git',
      args: ['remote', 'add', '--', 'origin', 'https://github.com/me/plant'],
      cwd: target,
      timeoutMs: 10000,
    });
    expect(maker.made()).toEqual([
      { path: target, repo: 'me/plant', kind: 'new', createdAt: 1000 },
    ]);
  });

  describe('create refuses before making anything', () => {
    const refuses = async (
      o: Parameters<typeof setup>[0],
      p: { name?: string; github?: boolean },
      expected: { code: string; message?: string },
      allowedCalls: string[] = [],
    ) => {
      const s = setup(o);
      const name = p.name ?? 'plant';
      const err = await failure(() =>
        s.maker.create({ createIn: code, name, github: p.github ?? false }),
      );
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject(expected);
      expect(ran(s.tools)).toEqual(allowedCalls);
      expect(s.maker.made()).toEqual([]);
      return s;
    };

    it('a bad name', async () => {
      const s = await refuses({ replies: [gitInit] }, { name: '../x' }, { code: 'INVALID_NAME' });
      expect(s.requireRunnable).not.toHaveBeenCalled();
      expect(existsSync(path.join(home, 'x'))).toBe(false);
    });

    // Windows drops a trailing dot: `plant.` would run git in the owner's `plant`, `...` in Create in.
    it.each(['plant.', '...'])('a name ending in a dot (%s)', async (name) => {
      mkdirSync(path.join(code, 'plant'));
      writeFileSync(path.join(code, 'plant', 'mine.txt'), 'x');
      await refuses({ replies: [gitInit] }, { name }, { code: 'INVALID_NAME' });
      expect(readdirSync(code)).toEqual(['plant']);
      expect(readdirSync(path.join(code, 'plant'))).toEqual(['mine.txt']);
    });

    it('an existing target, with the exact message', async () => {
      mkdirSync(path.join(code, 'plant'));
      writeFileSync(path.join(code, 'plant', 'mine.txt'), 'x');
      await refuses(
        { replies: [gitInit] },
        {},
        {
          code: 'EXISTS',
          message: `plant already exists in ${code}. Use the Existing folder tab to start there.`,
        },
      );
      expect(existsSync(path.join(code, 'plant', 'mine.txt'))).toBe(true);
      expect(existsSync(path.join(code, 'plant', '.git'))).toBe(false);
    });

    it('Claude missing', async () => {
      const s = setup({ replies: [gitInit] });
      s.requireRunnable.mockRejectedValueOnce(
        new ServiceError('CLAUDE_MISSING', 'Claude Code is not installed'),
      );
      const err = await failure(() =>
        s.maker.create({ createIn: code, name: 'plant', github: false }),
      );
      expect(err).toMatchObject({ code: 'CLAUDE_MISSING' });
      expect(s.tools.calls).toEqual([]);
      expect(existsSync(path.join(code, 'plant'))).toBe(false);
    });

    it('gh not ready', async () => {
      await refuses(
        { replies: [ghNotReady, repoFree, gitInit] },
        { github: true },
        { code: 'GH_NOT_READY', message: 'Run gh auth login on this machine (over SSH).' },
        ['gh auth status --hostname github.com'],
      );
      expect(existsSync(path.join(code, 'plant'))).toBe(false);
    });

    it('repo taken', async () => {
      await refuses(
        { replies: [ghReady, repoTaken, gitInit] },
        { github: true },
        { code: 'REPO_EXISTS', message: 'plant already exists on GitHub' },
        ['gh auth status --hostname github.com', 'gh repo view --json name -- plant'],
      );
      expect(existsSync(path.join(code, 'plant'))).toBe(false);
    });
  });

  it('a failed git init removes only the folder it made', async () => {
    mkdirSync(path.join(code, 'sibling'));
    const { maker } = setup({
      replies: [
        {
          cmd: 'git',
          match: /^init/,
          result: (call) => {
            mkdirSync(path.join(call.cwd!, '.git'));
            return { code: 128, stderr: 'fatal: cannot write\nmore' };
          },
        },
      ],
    });
    const err = await failure(() => maker.create({ createIn: code, name: 'plant', github: false }));
    expect(err).toMatchObject({ code: 'GIT_FAILED', message: 'fatal: cannot write' });
    expect(existsSync(path.join(code, 'plant'))).toBe(false);
    expect(existsSync(path.join(code, 'sibling'))).toBe(true);
    expect(existsSync(code)).toBe(true);
    expect(maker.made()).toEqual([]);
  });

  it('a target that appears after the checks is not made, nor removed', async () => {
    const target = path.join(code, 'plant');
    const { maker, tools } = setup({
      replies: [
        // Someone else makes the folder while gh is being asked.
        {
          cmd: 'gh',
          match: /^repo view --json name --/,
          result: () => {
            mkdirSync(target);
            writeFileSync(path.join(target, 'theirs.txt'), 'x');
            return { code: 1 };
          },
        },
        ghReady,
        gitInit,
      ],
    });
    const err = await failure(() => maker.create({ createIn: code, name: 'plant', github: true }));
    expect(err).toMatchObject({ code: 'EXISTS' });
    expect(existsSync(path.join(target, 'theirs.txt'))).toBe(true);
    expect(ran(tools)).not.toContain('git init');
  });

  it('a failed repo creation removes the new folder; a failed remote add keeps everything and returns a problem', async () => {
    const failed = setup({
      replies: [
        ghReady,
        repoFree,
        gitInit,
        { cmd: 'gh', match: /^repo create/, result: { code: 1, stderr: 'HTTP 500\nmore' } },
      ],
    });
    const err = await failure(() =>
      failed.maker.create({ createIn: code, name: 'plant', github: true }),
    );
    expect(err).toMatchObject({ code: 'GH_FAILED', message: 'HTTP 500' });
    expect(existsSync(path.join(code, 'plant'))).toBe(false);
    expect(failed.maker.made()).toEqual([]);

    const unconnected = setup({
      replies: [
        ghReady,
        repoFree,
        gitInit,
        repoCreated,
        repoAddress,
        { cmd: 'git', match: /^remote add/, result: { code: 3, stderr: 'error: locked\nmore' } },
      ],
    });
    const target = path.join(code, 'plant');
    expect(await unconnected.maker.create({ createIn: code, name: 'plant', github: true })).toEqual(
      {
        path: target,
        repo: 'me/plant',
        problem: 'the GitHub repo was created, but connecting it failed: error: locked',
      },
    );
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(unconnected.maker.made()).toEqual([
      { path: target, repo: 'me/plant', kind: 'new', createdAt: 1000 },
    ]);
    expect(unconnected.maker.createIn()).toBe(code);
  });

  it('a created repo whose address cannot be read keeps everything and returns a problem', async () => {
    const { maker, tools } = setup({
      replies: [
        ghReady,
        repoFree,
        gitInit,
        repoCreated,
        {
          cmd: 'gh',
          match: /^repo view --json nameWithOwner,url/,
          result: { code: 1, stderr: 'HTTP 502' },
        },
      ],
    });
    const target = path.join(code, 'plant');
    expect(await maker.create({ createIn: code, name: 'plant', github: true })).toEqual({
      path: target,
      repo: null,
      problem: 'the GitHub repo was created, but reading its address failed: HTTP 502',
    });
    expect(existsSync(path.join(target, '.git'))).toBe(true);
    expect(ran(tools).some((c) => c.startsWith('git remote add'))).toBe(false);
    expect(maker.made()).toEqual([{ path: target, repo: null, kind: 'new', createdAt: 1000 }]);
  });

  it('a missing Create in is NOT_FOUND unless it is the headless default, which is made', async () => {
    const desktop = setup({ replies: [gitInit] });
    const missing = path.join(home, 'threadgarden', 'projects');
    expect(
      await failure(() =>
        desktop.maker.create({ createIn: missing, name: 'plant', github: false }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(existsSync(missing)).toBe(false);

    const headless = setup({ headless: true, replies: [gitInit] });
    expect(
      await failure(() =>
        headless.maker.create({ createIn: path.join(home, 'other'), name: 'plant', github: false }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await failure(() =>
        headless.maker.create({ createIn: 'relative/dir', name: 'plant', github: false }),
      ),
    ).toMatchObject({ code: 'NOT_FOUND', message: 'Type a full path, or start with ~' });

    const made = await headless.maker.create({
      createIn: '~/threadgarden/projects',
      name: 'plant',
      github: false,
    });
    expect(made.path).toBe(path.join(missing, 'plant'));
    expect(existsSync(path.join(missing, 'plant', '.git'))).toBe(true);
    expect(headless.maker.createIn()).toBe(missing);
  });

  it('garbage in the record is ignored and replaced', async () => {
    const { maker, values } = setup({ replies: [gitInit], stored: { [MADE_KEY]: 'nonsense' } });
    expect(maker.made()).toEqual([]);
    await maker.create({ createIn: code, name: 'plant', github: false });
    expect(values.get(MADE_KEY)).toEqual([
      { path: path.join(code, 'plant'), repo: null, kind: 'new', createdAt: 1000 },
    ]);
    const mixed = setup({
      stored: { [MADE_KEY]: [{ path: '/a', repo: null, kind: 'new', createdAt: 1 }, 7, { x: 1 }] },
    });
    expect(mixed.maker.made()).toEqual([{ path: '/a', repo: null, kind: 'new', createdAt: 1 }]);
  });
});

describe('clone', () => {
  it('clone: existing same repo → existing; existing other folder → EXISTS; gh not ready → GH_NOT_READY', async () => {
    const target = path.join(code, 'thing');
    mkdirSync(target);
    const same = setup({ replies: [originIs('https://github.com/Me/Thing.git'), ghReady] });
    expect(await same.maker.clone({ createIn: code, repo: 'me/thing' })).toEqual({
      status: 'existing',
      path: target,
    });
    expect(same.tools.spawned).toEqual([]);

    const other = setup({ replies: [originIs('https://github.com/me/other'), ghReady] });
    expect(
      await failure(() => other.maker.clone({ createIn: code, repo: 'me/thing' })),
    ).toMatchObject({
      code: 'EXISTS',
      message: `thing already exists in ${code}. Use the Existing folder tab to start there.`,
    });
    expect(other.tools.spawned).toEqual([]);

    const notReady = setup({ replies: [ghNotReady] });
    expect(
      await failure(() => notReady.maker.clone({ createIn: code, repo: 'me/fresh' })),
    ).toMatchObject({ code: 'GH_NOT_READY' });
    expect(notReady.tools.spawned).toEqual([]);
    expect(existsSync(path.join(code, 'fresh'))).toBe(false);
  });

  it('a repo name ending in a dot is INVALID_NAME', async () => {
    mkdirSync(path.join(code, 'thing'));
    const s = setup({ replies: [originIs('https://github.com/owner/thing'), ghReady] });
    expect(
      await failure(() => s.maker.clone({ createIn: code, repo: 'owner/thing.' })),
    ).toMatchObject({ code: 'INVALID_NAME' });
    expect(s.tools.calls).toEqual([]);
    expect(s.requireRunnable).not.toHaveBeenCalled();
    expect(readdirSync(path.join(code, 'thing'))).toEqual([]);
  });

  it('Claude missing refuses before cloning', async () => {
    const s = setup({ replies: [ghReady] });
    s.requireRunnable.mockRejectedValueOnce(new ServiceError('CLAUDE_MISSING', 'missing'));
    expect(await failure(() => s.maker.clone({ createIn: code, repo: 'me/thing' }))).toMatchObject({
      code: 'CLAUDE_MISSING',
    });
    expect(s.tools.spawned).toEqual([]);
  });

  describe('clone job: done records it; failed removes the partial folder with the fatal line as error; cancel while running removes it; cancel after done keeps it', () => {
    const target = () => path.join(code, 'thing');
    const start = async () => {
      const s = setup({ replies: [ghReady] });
      const started = await s.maker.clone({ createIn: code, repo: 'me/thing' });
      expect(started).toEqual({
        status: 'started',
        job: { jobId: 'job-1', state: 'running', repo: 'me/thing', path: target(), error: null },
      });
      expect(s.tools.spawned[0]!.call.args).toEqual([
        'clone',
        '--origin',
        'origin',
        '--',
        'https://github.com/me/thing.git',
        target(),
      ]);
      // git fetched part of it
      mkdirSync(path.join(target(), '.git'), { recursive: true });
      return s;
    };

    it('done records it', async () => {
      const { maker, tools } = await start();
      expect(maker.job('job-1').state).toBe('running');
      tools.spawned[0]!.finish({ code: 0 });
      await vi.waitFor(() => expect(maker.job('job-1').state).toBe('done'));
      expect(maker.job('job-1').error).toBeNull();
      expect(existsSync(target())).toBe(true);
      expect(maker.made()).toEqual([
        { path: target(), repo: 'me/thing', kind: 'clone', createdAt: 1000 },
      ]);
      expect(maker.createIn()).toBe(code);
    });

    it('failed removes the partial folder with the fatal line as error', async () => {
      const { maker, tools } = await start();
      tools.spawned[0]!.finish({
        code: 128,
        stderr: "Cloning into 'thing'...\nfatal: repository not found\nfatal: second\n",
      });
      await vi.waitFor(() => expect(maker.job('job-1').state).toBe('failed'));
      expect(maker.job('job-1').error).toBe('fatal: repository not found');
      expect(existsSync(target())).toBe(false);
      expect(maker.made()).toEqual([]);

      const plain = setup({ replies: [ghReady] });
      await plain.maker.clone({ createIn: code, repo: 'me/thing' });
      plain.tools.spawned[0]!.finish({ code: 1, stderr: 'boom' });
      await vi.waitFor(() => expect(plain.maker.job('job-1').state).toBe('failed'));
      expect(plain.maker.job('job-1').error).toBe('git clone failed');
    });

    it('cancel while running removes it', async () => {
      const { maker, tools } = await start();
      maker.cancel('job-1');
      expect(maker.job('job-1').state).toBe('cancelled');
      expect(tools.spawned[0]!.cancelled).toBe(true);
      await vi.waitFor(() => expect(existsSync(target())).toBe(false));
      expect(maker.made()).toEqual([]);
    });

    it('a clone retried right after a cancel waits for the old folder to go, then starts anew', async () => {
      const s = setup({ replies: [ghReady, originIs('https://github.com/me/thing')] });
      await s.maker.clone({ createIn: code, repo: 'me/thing' });
      // git wrote origin early and fetched part of it; killing it takes a moment.
      mkdirSync(path.join(target(), '.git', 'objects'), { recursive: true });
      s.tools.spawned[0]!.exitOnCancel = false;
      s.maker.cancel('job-1');

      let answered = false;
      const retry = s.maker.clone({ createIn: code, repo: 'me/thing' });
      void retry.then(() => (answered = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(answered).toBe(false);

      s.tools.spawned[0]!.finish({ code: -1, stderr: 'killed' });
      expect(await retry).toEqual({
        status: 'started',
        job: { jobId: 'job-2', state: 'running', repo: 'me/thing', path: target(), error: null },
      });
      expect(s.tools.spawned).toHaveLength(2);
      // The new folder is a fresh one: the old partial clone was removed first.
      expect(readdirSync(target())).toEqual([]);
    });

    it('cancel after done keeps it', async () => {
      const { maker, tools } = await start();
      tools.spawned[0]!.finish({ code: 0 });
      await vi.waitFor(() => expect(maker.job('job-1').state).toBe('done'));
      maker.cancel('job-1');
      expect(maker.job('job-1').state).toBe('done');
      expect(tools.spawned[0]!.cancelled).toBe(false);
      expect(existsSync(path.join(target(), '.git'))).toBe(true);
    });
  });

  it('clone never removes a target that existed before the job', async () => {
    const target = path.join(code, 'thing');
    const { maker, tools } = setup({
      replies: [
        // The target appears after clone's existence check, while gh is being asked.
        {
          cmd: 'gh',
          match: AUTH,
          result: () => {
            mkdirSync(target);
            writeFileSync(path.join(target, 'theirs.txt'), 'x');
            return { stdout: 'Logged in to github.com account me' };
          },
        },
      ],
    });
    const err = await failure(() => maker.clone({ createIn: code, repo: 'me/thing' }));
    expect(err).toMatchObject({ code: 'EXISTS' });
    expect(tools.spawned).toEqual([]);
    expect(existsSync(path.join(target, 'theirs.txt'))).toBe(true);
  });

  it('unknown jobs are NOT_FOUND; a finished job is forgotten after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { maker, tools } = setup({ replies: [ghReady] });
    expect(() => maker.job('nope')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', message: 'No such clone' }),
    );
    expect(() => maker.cancel('nope')).not.toThrow();
    await maker.clone({ createIn: code, repo: 'me/thing' });
    tools.spawned[0]!.finish({ code: 0 });
    await vi.waitFor(() => expect(maker.job('job-1').state).toBe('done'));
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(maker.job('job-1').state).toBe('done');
    vi.advanceTimersByTime(60 * 1000);
    expect(() => maker.job('job-1')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});

describe('origins', () => {
  it('origins de-duplicates and skips non-GitHub projects', async () => {
    const urls: Record<string, string | null> = {
      a: 'git@github.com:Me/A.git',
      b: 'https://github.com/me/a',
      c: 'https://gitlab.com/me/c',
      d: null,
      e: 'https://github.com/me/e.git',
    };
    const { maker } = setup({
      recent: Object.keys(urls).map((k) => path.join(code, k)),
      replies: [
        {
          cmd: 'git',
          match: /^remote get-url origin/,
          result: (call) => {
            const url = urls[path.basename(call.cwd!)];
            return url ? { stdout: url + '\n' } : { code: 2, stderr: 'no such remote' };
          },
        },
      ],
    });
    expect(await maker.origins()).toEqual(['me/a', 'me/e']);
  });
});
