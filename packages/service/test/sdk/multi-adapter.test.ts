import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import {
  CodexNotFoundError,
  type CodexConnection,
  type ConnectCodex,
} from '../../src/sdk/codex-client.js';
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

describe("Codex's model catalog", () => {
  /** A connection answering `model/list` and `config/read` (or failing them). */
  const catalog = (opts: {
    models: Record<string, unknown>[];
    configModel?: string | null;
    configFails?: boolean;
    listFails?: boolean;
  }): ConnectCodex => {
    return () => ({
      request: vi.fn(async (method: string) => {
        if (method === 'model/list') {
          if (opts.listFails) throw new Error('catalog unavailable');
          return { data: opts.models, nextCursor: null };
        }
        if (method === 'config/read') {
          if (opts.configFails) throw new Error('unknown method');
          return { config: { model: opts.configModel ?? null }, origins: {} };
        }
        return {};
      }),
      notify: vi.fn(),
      reply: vi.fn(),
      reject: vi.fn(),
      close: vi.fn(),
    });
  };
  const defaults = (models: { value: string; isDefault?: boolean }[]) =>
    models.filter((m) => m.isDefault).map((m) => m.value);
  const twoModels = [
    { model: 'gpt-a', displayName: 'A', isDefault: false },
    { model: 'gpt-b', displayName: 'B', isDefault: true },
  ];

  it("marks the catalog's default when the config names none", async () => {
    const adapter = new MultiAdapter(
      new FakeAdapter(),
      new CodexAdapter(dir, catalog({ models: twoModels })),
      () => ({}),
    );
    expect(defaults(await adapter.models())).toEqual(['codex:gpt-b']);
  });

  it("marks the config's model, which Codex uses for a new thread", async () => {
    const adapter = new MultiAdapter(
      new FakeAdapter(),
      new CodexAdapter(dir, catalog({ models: twoModels, configModel: 'gpt-a' })),
      () => ({}),
    );
    expect(defaults(await adapter.models())).toEqual(['codex:gpt-a']);
  });

  it("falls back to the catalog's default when the config can't be read or names an unknown model", async () => {
    for (const opts of [{ configFails: true }, { configModel: 'gpt-unlisted' }]) {
      const adapter = new MultiAdapter(
        new FakeAdapter(),
        new CodexAdapter(dir, catalog({ models: twoModels, ...opts })),
        () => ({}),
      );
      expect(defaults(await adapter.models())).toEqual(['codex:gpt-b']);
    }
  });

  it('offers no Codex model when the CLI is not installed', async () => {
    const missing: ConnectCodex = () => {
      throw new CodexNotFoundError();
    };
    const adapter = new MultiAdapter(new FakeAdapter(), new CodexAdapter(dir, missing), () => ({}));
    expect(await adapter.models()).toEqual([]);
  });

  it('offers one default Codex row when the CLI is there but its catalog fails', async () => {
    const adapter = new MultiAdapter(
      new FakeAdapter(),
      new CodexAdapter(dir, catalog({ models: [], listFails: true })),
      () => ({}),
    );
    expect(await adapter.models()).toEqual([
      expect.objectContaining({ value: 'codex:default', isDefault: true }),
    ]);
  });
});
