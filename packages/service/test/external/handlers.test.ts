import { describe, expect, it, vi } from 'vitest';
import { ExternalPoller } from '../../src/external/poller.js';
import { registerExternalHandlers } from '../../src/server/handlers/external.js';
import { Router } from '../../src/server/router.js';

const NOW = 5_000_000;
const AGENTS = [
  {
    id: 'abc12345',
    cwd: '/p',
    kind: 'background',
    startedAt: 1,
    sessionId: 'bg',
    state: 'working',
  },
  { pid: 9, cwd: '/p', kind: 'interactive', startedAt: 1, sessionId: 'term', status: 'idle' },
  { id: 'dead0000', cwd: '/p', kind: 'background', startedAt: 1, sessionId: 'fin', state: 'done' },
];

const setup = (run: () => Promise<string>, withPoller = true) => {
  const poller = new ExternalPoller(
    run,
    () => new Set(),
    () => {},
  );
  const router = new Router();
  registerExternalHandlers(router, {
    ...(withPoller ? { poller } : {}),
    lastModifiedOf: (id) => (id === 'recent' ? NOW - 5_000 : undefined),
    claude: () => ({ path: '/bin/claude', version: '2.1.314' }),
    indexing: () => ({ done: 3, total: 9 }),
    now: () => NOW,
  });
  const call = async (method: string, params: unknown = {}) => {
    const r = await router.dispatch({ id: 1, method, params } as never, { clientId: 'c' });
    if ('error' in r) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as Record<string, unknown>;
  };
  return { poller, call };
};

describe('external handlers', () => {
  it('chat.resumeCheck polls fresh and blocks live sessions', async () => {
    const run = vi.fn(async () => JSON.stringify(AGENTS));
    const t = setup(run);
    expect(await t.call('chat.resumeCheck', { sessionId: 'bg' })).toMatchObject({
      status: 'blocked',
    });
    expect(await t.call('chat.resumeCheck', { sessionId: 'term' })).toMatchObject({
      status: 'blocked',
    });
    expect(await t.call('chat.resumeCheck', { sessionId: 'fin' })).toMatchObject({ status: 'ok' });
    expect(await t.call('chat.resumeCheck', { sessionId: 'nope' })).toMatchObject({ status: 'ok' });
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('chat.resumeCheck is unverified when claude agents fails, and flags recent edits', async () => {
    const t = setup(async () => {
      throw new Error('boom');
    });
    expect(await t.call('chat.resumeCheck', { sessionId: 'recent' })).toMatchObject({
      status: 'unverified',
      recentlyModified: true,
    });
    expect(await t.call('chat.resumeCheck', { sessionId: 'old' })).toMatchObject({
      status: 'unverified',
      recentlyModified: false,
    });
  });

  it('chat.resumeCheck is unverified without a poller', async () => {
    const t = setup(async () => '[]', false);
    expect(await t.call('chat.resumeCheck', { sessionId: 'x' })).toMatchObject({
      status: 'unverified',
    });
  });

  it('chat.resumeCommand attaches background sessions', async () => {
    const t = setup(async () => JSON.stringify(AGENTS));
    await t.poller.refresh();
    expect(await t.call('chat.resumeCommand', { sessionId: 'bg' })).toEqual({
      command: 'claude attach abc12345',
    });
    expect(await t.call('chat.resumeCommand', { sessionId: 'term' })).toEqual({
      command: 'claude --resume term',
    });
  });

  it('ui.visibility forwards to the poller', async () => {
    const t = setup(async () => '[]');
    const spy = vi.spyOn(t.poller, 'setVisible');
    await t.call('ui.visibility', { visible: false });
    expect(spy).toHaveBeenCalledWith(false);
  });

  it('system.status reports claude, external availability and indexing', async () => {
    const t = setup(async () => '[]');
    await t.poller.refresh();
    expect(await t.call('system.status')).toEqual({
      claude: { found: true, path: '/bin/claude', version: '2.1.314' },
      externalAvailable: true,
      indexing: { done: 3, total: 9 },
    });
  });
});
