import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRepo,
  githubStatus,
  listRepos,
  originOf,
  repoExists,
  runTool,
  startClone,
  spawnTool,
  toolEnv,
} from '../../src/projects/github.js';
import { fakeTools, type Reply } from './fake-tools.js';

const AUTH = /^auth status/;

describe('toolEnv', () => {
  it('every run gets a no-prompt environment', () => {
    const env = toolEnv({ GIT_DIR: 'x', GIT_WORK_TREE: 'y', GIT_INDEX_FILE: 'z', PATH: 'p' });
    expect(env).toMatchObject({
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      PATH: 'p',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
  });

  it('never waits on a credential prompt', () => {
    const env = toolEnv({ GIT_ASKPASS: 'a', SSH_ASKPASS: 'b', PATH: 'p' });
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.GCM_INTERACTIVE).toBe('never');
  });
});

describe('runTool', () => {
  it('systemTools runs with a timeout', async () => {
    const t0 = Date.now();
    const r = await runTool(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
      timeoutMs: 200,
    });
    expect(r.code).toBe(-1);
    expect(r.stderr).toBe('timed out');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('captures output and exit code; a missing executable is code 127', async () => {
    const ok = await runTool(process.execPath, ['-e', 'console.log("hi");process.exit(3)'], {
      timeoutMs: 5000,
    });
    expect(ok).toMatchObject({ code: 3, stdout: 'hi\n' });
    const missing = await runTool('threadgarden-no-such-tool', [], { timeoutMs: 5000 });
    expect(missing).toEqual({ code: 127, stdout: '', stderr: 'command not found' });
  });
});

describe('stopping a process tree', () => {
  // A child that starts a grandchild holding the same pipes; the grandchild would write a marker
  // after 2 s. Killing only the launcher would leave it alive (the way git.exe behaves on Windows).
  const scenario = (marker: string): string[] => {
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(marker + '.up')},'x');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),2000);setTimeout(()=>{},10000)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setTimeout(()=>{},10000)`;
    return ['-e', parent];
  };
  const withDir = async (fn: (marker: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-tree-'));
    try {
      await fn(join(dir, 'marker'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await sleep(50);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('cancel settles done and kills the grandchild too', async () => {
    await withDir(async (marker) => {
      const job = spawnTool(process.execPath, scenario(marker), {});
      await until(() => existsSync(marker + '.up'));
      const t0 = Date.now();
      job.cancel();
      expect((await job.done).code).toBe(-1);
      expect(Date.now() - t0).toBeLessThan(3000);
      await sleep(2500);
      expect(existsSync(marker)).toBe(false);
    });
  }, 15000);

  it('cancel after the process finished kills nothing, and cancelling twice kills once', async () => {
    let kills = 0;
    const kill = async () => {
      kills++;
    };
    const finished = spawnTool(process.execPath, ['-e', '0'], { kill });
    await finished.done;
    finished.cancel();
    expect(kills).toBe(0);

    const running = spawnTool(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
      kill: async (c) => {
        kills++;
        c.kill();
      },
    });
    running.cancel();
    running.cancel();
    await running.done;
    expect(kills).toBe(1);
  });

  it('a timeout kills the grandchild too', async () => {
    await withDir(async (marker) => {
      const r = await runTool(process.execPath, scenario(marker), { timeoutMs: 1000 });
      expect(r).toMatchObject({ code: -1, stderr: 'timed out' });
      await sleep(2500);
      expect(existsSync(marker)).toBe(false);
    });
  }, 15000);
});

describe('githubStatus', () => {
  it('ready with login', async () => {
    const t = fakeTools([
      {
        cmd: 'gh',
        match: AUTH,
        result: { stdout: 'github.com\n  Logged in to github.com account octo-cat (keyring)\n' },
      },
    ]);
    expect(await githubStatus(t)).toEqual({ ready: true, login: 'octo-cat', problem: null });
    expect(t.calls[0]).toMatchObject({
      cmd: 'gh',
      args: ['auth', 'status', '--hostname', 'github.com'],
      timeoutMs: 10000,
    });
  });

  it('not signed in, keyring, gh missing', async () => {
    const out = async (result: { code: number; stderr: string }) =>
      githubStatus(fakeTools([{ cmd: 'gh', match: AUTH, result }]));
    expect(await out({ code: 1, stderr: 'You are not logged into any GitHub hosts.' })).toEqual({
      ready: false,
      login: null,
      problem: 'Run gh auth login on this machine (over SSH).',
    });
    expect((await out({ code: 1, stderr: 'failed to read keyring: locked' })).problem).toBe(
      'gh cannot read its keyring. Run gh auth login --insecure-storage on this machine (over SSH).',
    );
    expect(await out({ code: 127, stderr: 'command not found' })).toEqual({
      ready: false,
      login: null,
      problem: 'GitHub CLI (gh) is not installed on this machine.',
    });
  });
});

describe('listRepos', () => {
  const repo = (full: string, at: string, priv = false) => ({
    full_name: full,
    private: priv,
    updated_at: at,
    default_branch: 'main',
  });

  it('paginated arrays merge, sorted newest first', async () => {
    const page1 = JSON.stringify([
      repo('a/old', '2024-01-01T00:00:00Z'),
      repo('a/we"ird],[', '2024-03-01T00:00:00Z', true),
    ]);
    const page2 = JSON.stringify([repo('b/new', '2025-01-01T00:00:00Z')]);
    const t = fakeTools([{ cmd: 'gh', match: /^api/, result: { stdout: page1 + page2 + '\n' } }]);
    const repos = await listRepos(t);
    expect(repos.map((r) => r.fullName)).toEqual(['b/new', 'a/we"ird],[', 'a/old']);
    expect(repos[0]).toEqual({
      fullName: 'b/new',
      private: false,
      updatedAt: Date.parse('2025-01-01T00:00:00Z'),
      defaultBranch: 'main',
    });
    expect(t.calls[0]).toMatchObject({
      args: [
        'api',
        '--paginate',
        'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
      ],
      timeoutMs: 60000,
    });
  });

  it('failure is GH_NOT_READY when gh is not ready, else GH_FAILED with the first stderr line', async () => {
    const notReady = fakeTools([
      { cmd: 'gh', match: /^api/, result: { code: 4, stderr: 'auth needed' } },
      { cmd: 'gh', match: AUTH, result: { code: 1, stderr: 'nope' } },
    ]);
    await expect(listRepos(notReady)).rejects.toMatchObject({
      code: 'GH_NOT_READY',
      message: 'Run gh auth login on this machine (over SSH).',
    });
    const failed = fakeTools([
      { cmd: 'gh', match: /^api/, result: { code: 1, stderr: 'HTTP 502\nmore' } },
      { cmd: 'gh', match: AUTH, result: { stdout: 'Logged in to github.com account me' } },
    ]);
    await expect(listRepos(failed)).rejects.toMatchObject({
      code: 'GH_FAILED',
      message: 'HTTP 502',
    });
  });
});

describe('createRepo and repoExists', () => {
  it('create: private, and a taken name is REPO_EXISTS', async () => {
    const t = fakeTools([
      {
        cmd: 'gh',
        match: /^repo view/,
        result: { stdout: '{"nameWithOwner":"me/thing","url":"https://github.com/me/thing"}' },
      },
      { cmd: 'gh', match: /^repo create/, result: {} },
    ]);
    expect(await createRepo(t, 'thing')).toEqual({
      fullName: 'me/thing',
      url: 'https://github.com/me/thing',
    });
    expect(t.calls[0]!.args).toEqual(['repo', 'create', '--private', '--', 'thing']);
    expect(t.calls[0]!.timeoutMs).toBe(30000);

    const taken = fakeTools([
      {
        cmd: 'gh',
        match: /^repo create/,
        result: {
          code: 1,
          stderr: 'GraphQL: Name already exists on this account (createRepository)',
        },
      },
    ]);
    await expect(createRepo(taken, 'thing')).rejects.toMatchObject({
      code: 'REPO_EXISTS',
      message: 'thing already exists on GitHub',
    });
  });

  it('a created repo whose address cannot be read is REPO_CREATED', async () => {
    const t = fakeTools([
      { cmd: 'gh', match: /^repo view/, result: { code: 1, stderr: 'HTTP 502\nmore' } },
      { cmd: 'gh', match: /^repo create/, result: {} },
    ]);
    await expect(createRepo(t, 'thing')).rejects.toMatchObject({
      code: 'REPO_CREATED',
      message: 'the GitHub repo was created, but reading its address failed: HTTP 502',
    });
    const unreadable = fakeTools([
      { cmd: 'gh', match: /^repo view/, result: { stdout: 'not json' } },
      { cmd: 'gh', match: /^repo create/, result: {} },
    ]);
    await expect(createRepo(unreadable, 'thing')).rejects.toMatchObject({
      code: 'REPO_CREATED',
      message:
        'the GitHub repo was created, but reading its address failed: gh returned something unreadable',
    });
  });

  it('repoExists follows the exit code', async () => {
    const yes = fakeTools([{ cmd: 'gh', match: /^repo view/, result: {} }]);
    expect(await repoExists(yes, 'me/x')).toBe(true);
    expect(yes.calls[0]!.args).toEqual(['repo', 'view', '--json', 'name', '--', 'me/x']);
    const no = fakeTools([{ cmd: 'gh', match: /^repo view/, result: { code: 1 } }]);
    expect(await repoExists(no, 'me/x')).toBe(false);
  });
});

describe('startClone', () => {
  it('clones over https with origin named origin, and can be cancelled', async () => {
    const t = fakeTools();
    const job = startClone(t, 'me/thing', '/home/me/thing');
    expect(t.calls[0]).toMatchObject({
      cmd: 'git',
      args: [
        'clone',
        '--origin',
        'origin',
        '--',
        'https://github.com/me/thing.git',
        '/home/me/thing',
      ],
    });
    job.cancel();
    expect(t.spawned[0]!.cancelled).toBe(true);
    expect((await job.done).code).toBe(-1);
  });
});

describe('originOf', () => {
  const atTop: Reply = { cmd: 'git', match: /^rev-parse --show-prefix$/, result: { stdout: '\n' } };
  const origin = async (url: string | null) =>
    originOf(
      fakeTools([
        atTop,
        {
          cmd: 'git',
          match: /^remote get-url origin/,
          result: url === null ? { code: 2, stderr: 'no such remote' } : { stdout: url + '\n' },
        },
      ]),
      '/d',
    );

  it('https and ssh github remotes give owner/name; other hosts give null', async () => {
    expect(await origin('git@github.com:Jiri/A.git')).toBe('jiri/a');
    expect(await origin('https://github.com/jiri/a')).toBe('jiri/a');
    expect(await origin('https://github.com/jiri/a.git/')).toBe('jiri/a');
    expect(await origin('ssh://git@github.com/Jiri/A.git')).toBe('jiri/a');
    expect(await origin('https://gitlab.com/x/y')).toBeNull();
    expect(await origin('https://notgithub.com/x/y')).toBeNull();
    expect(await origin(null)).toBeNull();
  });

  it('a plain folder inside a bigger repo has no origin of its own, nor does a non-repo', async () => {
    const bigOrigin: Reply = {
      cmd: 'git',
      match: /^remote get-url origin/,
      result: { stdout: 'https://github.com/me/big\n' },
    };
    const inside = fakeTools([
      { cmd: 'git', match: /^rev-parse --show-prefix$/, result: { stdout: 'sub/\n' } },
      bigOrigin,
    ]);
    expect(await originOf(inside, '/big/sub')).toBeNull();
    expect(inside.calls.map((c) => [c.args.join(' '), c.cwd])).toEqual([
      ['rev-parse --show-prefix', '/big/sub'],
    ]);

    const plain = fakeTools([
      {
        cmd: 'git',
        match: /^rev-parse --show-prefix$/,
        result: { code: 128, stderr: 'fatal: not a git repository' },
      },
      bigOrigin,
    ]);
    expect(await originOf(plain, '/plain')).toBeNull();
  });
});
