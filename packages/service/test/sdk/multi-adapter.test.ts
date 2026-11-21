import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import type { CodexConnection, ConnectCodex } from '../../src/sdk/codex-client.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-multi-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Codex connection that only records the environment it was started with. */
const recording = () => {
  const envs: NodeJS.ProcessEnv[] = [];
  const connect: ConnectCodex = (env) => {
    envs.push(env);
    const client: CodexConnection = {
      request: vi.fn(async (method: string) => {
        if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'm' };
        if (method === 'model/list')
          return { data: [{ model: 'm', displayName: 'M' }], nextCursor: null };
        return {};
      }),
      notify: vi.fn(),
      reply: vi.fn(),
      reject: vi.fn(),
      close: vi.fn(),
    };
    return client;
  };
  return { envs, connect };
};

const ANTHROPIC_SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-session',
  Anthropic_Api_Key: 'sk-ant-mixed-case',
  THREADGARDEN_ANTHROPIC_API_KEY: 'sk-ant-worker',
  ANTHROPIC_AUTH_TOKEN: 'gateway-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
};
const leaked = (env: NodeJS.ProcessEnv): string[] =>
  Object.keys(env).filter((key) =>
    /^(THREADGARDEN_)?ANTHROPIC_(API_KEY|AUTH_TOKEN)$|^CLAUDE_CODE_OAUTH_TOKEN$/i.test(key),
  );

describe('MultiAdapter', () => {
  it('never hands an Anthropic secret to a Codex chat', async () => {
    const { envs, connect } = recording();
    const adapter = new MultiAdapter(new FakeAdapter(), new CodexAdapter(dir, connect), () => ({}));
    const session = adapter.start({
      cwd: dir,
      env: { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://gateway', ...ANTHROPIC_SECRETS },
      claudePath: '',
      model: 'codex:m',
      sessionId: 'codex-00000000-0000-4000-8000-000000000001',
      canUseTool: async () => ({ behavior: 'allow' }),
    });
    await vi.waitFor(() => expect(envs).toHaveLength(1));
    expect(leaked(envs[0]!)).toEqual([]);
    // Everything else the session was given still reaches Codex.
    expect(envs[0]).toMatchObject({ PATH: '/bin', ANTHROPIC_BASE_URL: 'https://gateway' });
    session.close();
  });

  it("keeps the service's own Anthropic keys out of Codex's catalog, history and runtime calls", async () => {
    const { envs, connect } = recording();
    const adapter = new MultiAdapter(new FakeAdapter(), new CodexAdapter(dir, connect), () => ({
      PATH: '/bin',
      ...ANTHROPIC_SECRETS,
    }));
    await adapter.models();
    await adapter.listPolledSessions().catch(() => {});
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(leaked(env)).toEqual([]);
      expect(env.PATH).toBe('/bin');
    }
    adapter.dispose();
  });

  it('leaves a Claude chat its key', () => {
    const claude = new FakeAdapter();
    const adapter = new MultiAdapter(claude, new CodexAdapter(dir, recording().connect));
    adapter
      .start({
        cwd: dir,
        env: { ANTHROPIC_API_KEY: 'sk-ant-session' },
        claudePath: '',
        model: 'sonnet',
        canUseTool: async () => ({ behavior: 'allow' }),
      })
      .close();
    expect(claude.started[0]!.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-session' });
  });
});
