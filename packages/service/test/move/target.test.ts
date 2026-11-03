/**
 * `move.target`: which folder on the target a moved chat uses (§4 "The folder there").
 */
import { join } from 'node:path';
import type { GitState } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import { repoOfUrl } from '../../src/projects/github.js';
import { pickTarget, type TargetDeps } from '../../src/server/handlers/move.js';
import { fakeTools, type Reply } from '../projects/fake-tools.js';

const CREATE_IN = join('/home', 'me', 'projects');

type Clone = { cwd: string; url: string; git: GitState | 'throws' };

const clean = (branch: string | null, url = 'https://github.com/me/app.git'): GitState => ({
  kind: 'clean',
  branch,
  origin: url,
});
const dirty = (branch: string | null, url = 'https://github.com/me/app.git'): GitState => ({
  kind: 'dirty',
  branch,
  origin: url,
  changed: 2,
  unpushed: 0,
});

const deps = (
  clones: Clone[],
  over: { live?: { cwd: string }[]; headless?: boolean } = {},
): TargetDeps => {
  // The fake replays the first matching reply, so one reply per command looks the clone up.
  const at = (cwd?: string) => clones.find((c) => c.cwd === cwd);
  const replies: Reply[] = [
    {
      cmd: 'git',
      match: /^rev-parse --show-prefix$/,
      result: (call) => (at(call.cwd) ? { stdout: '\n' } : { code: 128 }),
    },
    {
      cmd: 'git',
      match: /^remote get-url origin/,
      result: (call) => {
        const c = at(call.cwd);
        return c ? { stdout: c.url + '\n' } : { code: 2 };
      },
    },
  ];
  return {
    tools: fakeTools(replies),
    recentCwds: () => clones.map((c) => c.cwd),
    createIn: () => CREATE_IN,
    liveChats: () => (over.live ?? []).map((l) => ({ cwd: l.cwd })),
    headless: over.headless ?? true,
    gitState: async (cwd) => {
      const c = clones.find((x) => x.cwd === cwd)!;
      if (c.git === 'throws') throw new Error('git failed');
      return c.git;
    },
  };
};

const ask = { origin: 'https://github.com/me/app', repoName: 'app', branch: 'fix/usage' };

describe('repoOfUrl', () => {
  it('https and ssh forms of a github repo agree; other hosts keep their URL', () => {
    expect(repoOfUrl('git@github.com:Me/App.git')).toBe('me/app');
    expect(repoOfUrl(' https://github.com/me/app/ ')).toBe('me/app');
    expect(repoOfUrl('ssh://git@github.com/ME/app.git')).toBe('me/app');
    expect(repoOfUrl(' https://gitlab.com/x/y.git ')).toBe('https://gitlab.com/x/y.git');
  });
});

describe('move.target', () => {
  it("prefers the clone on the chat's branch", async () => {
    const d = deps([
      { cwd: '/w/a', url: 'https://github.com/me/app', git: clean('main') },
      { cwd: '/w/b', url: 'https://github.com/me/app', git: dirty('fix/usage') },
    ]);
    expect(await pickTarget(d, ask)).toEqual({ folder: '/w/b', matched: true, inUse: null });
  });

  it('next prefers a clean one with no live chat', async () => {
    const d = deps(
      [
        { cwd: '/w/a', url: 'https://github.com/me/app', git: dirty('main') },
        { cwd: '/w/b', url: 'https://github.com/me/app', git: clean('main') },
        { cwd: '/w/c', url: 'https://github.com/me/app', git: clean('dev') },
      ],
      { live: [{ cwd: '/w/b' }] },
    );
    expect(await pickTarget(d, ask)).toMatchObject({ folder: '/w/c', matched: true });
  });

  it('a clone whose git fails is skipped as a preference but still matches', async () => {
    const d = deps([{ cwd: '/w/a', url: 'https://github.com/me/app', git: 'throws' }]);
    expect(await pickTarget(d, ask)).toEqual({ folder: '/w/a', matched: true, inUse: null });
  });

  it('ssh and https origins of the same repo match', async () => {
    const d = deps([{ cwd: '/w/a', url: 'git@github.com:Me/App.git', git: clean('fix/usage') }]);
    expect(await pickTarget(d, ask)).toMatchObject({ folder: '/w/a', matched: true });
  });

  it('a non-github origin matches by its URL as it is', async () => {
    const url = 'https://gitlab.com/x/y.git';
    const d = deps([
      { cwd: '/w/a', url: 'https://gitlab.com/x/other.git', git: clean('fix/usage', url) },
      { cwd: '/w/b', url, git: clean('main', url) },
    ]);
    expect(await pickTarget(d, { origin: url, repoName: 'y', branch: 'fix/usage' })).toMatchObject({
      folder: '/w/b',
      matched: true,
    });
  });

  it('no match → createIn/repoName, matched false', async () => {
    const d = deps([{ cwd: '/w/a', url: 'https://github.com/me/other', git: clean('main') }]);
    expect(await pickTarget(d, ask)).toEqual({
      folder: join(CREATE_IN, 'app'),
      matched: false,
      inUse: null,
    });
  });

  it('a clone at createIn/repoName with no chats is found and matched', async () => {
    const folder = join(CREATE_IN, 'app');
    const d = deps([{ cwd: folder, url: 'git@github.com:me/app.git', git: clean('main') }]);
    d.recentCwds = () => [];
    expect(await pickTarget(d, ask)).toEqual({ folder, matched: true, inUse: null });
  });

  it('null origin (not a repo) → createIn/<folder name>', async () => {
    const d = deps([{ cwd: '/w/a', url: 'https://github.com/me/app', git: clean('main') }]);
    expect(await pickTarget(d, { origin: null, repoName: 'notes', branch: null })).toEqual({
      folder: join(CREATE_IN, 'notes'),
      matched: false,
      inUse: null,
    });
  });

  it('matched folder on another branch with a live chat → inUse {branch, running: 1}', async () => {
    const d = deps([{ cwd: '/w/a', url: 'https://github.com/me/app', git: dirty('main') }], {
      live: [{ cwd: '/w/a' }],
    });
    expect(await pickTarget(d, ask)).toEqual({
      folder: '/w/a',
      matched: true,
      inUse: { branch: 'main', running: 1 },
    });
  });

  it('another branch with no live chat is not in use', async () => {
    const d = deps([{ cwd: '/w/a', url: 'https://github.com/me/app', git: dirty('main') }]);
    expect((await pickTarget(d, ask)).inUse).toBeNull();
  });

  it("on This PC a matched folder with uncommitted changes is in use, even on the chat's branch", async () => {
    const clones: Clone[] = [
      { cwd: '/w/a', url: 'https://github.com/me/app', git: dirty('fix/usage') },
    ];
    expect(await pickTarget(deps(clones, { headless: false }), ask)).toEqual({
      folder: '/w/a',
      matched: true,
      inUse: { branch: 'fix/usage', running: 0 },
    });
    expect((await pickTarget(deps(clones, { headless: true }), ask)).inUse).toBeNull();
  });
});
