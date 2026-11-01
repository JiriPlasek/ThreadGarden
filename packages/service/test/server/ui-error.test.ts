import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type ServiceHandle } from '../../src/main.js';
import { generateCorpus } from '../../src/testing/corpus.js';

/** The window's own errors land in the service log, where they can be found later. */
describe('ui.error', () => {
  let dir: string;
  let svc: ServiceHandle;
  const errors: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threadgarden-ui-error-'));
    svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter: generateCorpus({ sessions: 1, projects: 1, bigSessionMessages: 0 }),
      installSignalHandlers: false,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error: (m: string) => void errors.push(m),
        flush: async () => {},
      },
    });
  });
  afterAll(async () => {
    await svc.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the error, where it happened and its stack to the log', async () => {
    const res = await svc.router.dispatch(
      {
        id: 1,
        method: 'ui.error',
        params: {
          where: 'render',
          message: 'Cannot read properties of undefined',
          stack: 'TypeError: Cannot read…\n    at ChatList.svelte:12:3',
        },
      },
      { clientId: 'w', origin: 'local' },
    );
    expect(res).toEqual({ id: 1, result: {} });
    const line = errors.find((e) => e.startsWith('ui (render)'));
    expect(line).toContain('Cannot read properties of undefined');
    expect(line).toContain('at ChatList.svelte:12:3');
  });
});
