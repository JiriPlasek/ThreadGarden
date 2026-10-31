/**
 * Opt-in smoke test against the installed `claude` and the user's own login
 * (`pnpm --filter @threadgarden/service test:real`, which sets THREADGARDEN_REAL=1). It
 * sends one tiny prompt in a throwaway git repo; any tool request is denied.
 * Findings are printed with a `[threadgarden-real]` prefix for docs/architecture.md.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem, EventMsg } from '@threadgarden/protocol';
import { LiveSession, type LiveRegistry } from '../../src/chat/live-session.js';
import type {
  AgentAdapter,
  AgentSession,
  SDKMessage,
  StartOptions,
} from '../../src/sdk/adapter.js';
import { findInstalledClaude } from '../../src/sdk/claude-path.js';
import { RealAdapter, buildSessionEnv } from '../../src/sdk/real-adapter.js';

const REAL = process.env.THREADGARDEN_REAL === '1';
// Obviously fake; it must never authenticate. Used only to see which auth the CLI picks.
const DUMMY_KEY = 'sk-ant-api03-threadgarden-dummy-key-not-real';

const report = (label: string, value: unknown): void => {
  console.log(`[threadgarden-real] ${label}: ${JSON.stringify(value)}`);
};

/** Records every raw SDK message, so the test can look below the normalizer. */
class TapAdapter extends RealAdapter implements AgentAdapter {
  readonly raw: SDKMessage[] = [];
  readonly sessions: AgentSession[] = [];

  override start(o: StartOptions): AgentSession {
    const inner = super.start(o);
    this.sessions.push(inner);
    const raw = this.raw;
    const messages: AsyncIterable<SDKMessage> = {
      async *[Symbol.asyncIterator]() {
        for await (const m of inner.messages) {
          raw.push(m);
          yield m;
        }
      },
    };
    return {
      messages,
      send: (m) => inner.send(m),
      interrupt: () => inner.interrupt(),
      setModel: (m) => inner.setModel(m),
      setPermissionMode: (m) => inner.setPermissionMode(m),
      stopTask: (id) => inner.stopTask(id),
      supportedCommands: () => inner.supportedCommands(),
      supportedModels: () => inner.supportedModels(),
      accountInfo: () => inner.accountInfo(),
      close: () => inner.close(),
    };
  }
}

const registry: LiveRegistry = {
  markLive: () => {},
  markEnded: () => {},
  listLive: () => [],
};

const waitFor = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!REAL)('real Claude Code (THREADGARDEN_REAL=1)', () => {
  let dir = '';
  let claudePath = '';

  beforeAll(async () => {
    const found = await findInstalledClaude(null);
    if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
    claudePath = found.path;
    report('claude', { version: found.version, ext: path.extname(found.path) });
    dir = mkdtempSync(path.join(os.tmpdir(), 'threadgarden-real-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });

  afterAll(async () => {
    if (!dir) return;
    // A closed session's `claude` process exits a second or two later; until then
    // Windows keeps its working folder busy.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (attempt >= 40) {
          report('cleanup', `left ${dir}: ${String(err)}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  it('runs a turn end to end with the sessionId Threadgarden chose', async () => {
    const adapter = new TapAdapter();
    const events: EventMsg[] = [];
    const sessionId = randomUUID();
    // Filled after create(): emit can run during create, before the session exists.
    const ref: { s?: LiveSession } = {};
    ref.s = LiveSession.create(
      dir,
      { text: 'Reply with the word pong and nothing else. Do not use any tools.' },
      {
        adapter,
        registry,
        claudePath,
        env: buildSessionEnv(process.env, null),
        sessionId,
        permissionMode: 'default',
        now: Date.now,
        emit: (e) => {
          events.push(e);
          // Never let the model act: deny every tool request.
          const live = ref.s;
          if (e.event === 'needsYou' && live) {
            for (const p of live.pendingRequests()) {
              if (p.kind === 'permissionRequest') live.respond(p.requestId, { decision: 'deny' });
            }
          }
        },
      },
    );
    const live = ref.s;
    const items = (): ChatItem[] => live.snapshot(1_000).items;
    try {
      await waitFor(
        () => items().some((i) => i.kind === 'result') || live.status === 'failed',
        150_000,
        'a result',
      );
      const all = items();
      report(
        'items',
        all.map((i) => (i.kind === 'unknown' ? `unknown:${i.sdkType}` : i.kind)),
      );
      expect(live.status, JSON.stringify(all.filter((i) => i.kind === 'system'))).not.toBe(
        'failed',
      );
      const text = all
        .filter((i) => i.kind === 'assistantText')
        .map((i) => (i.kind === 'assistantText' ? i.markdown : ''))
        .join(' ');
      expect(text.toLowerCase()).toContain('pong');
      expect(all.some((i) => i.kind === 'result')).toBe(true);

      // (a) the CLI uses the id Threadgarden passed as `sessionId`.
      const init = adapter.raw.find(
        (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'init',
      ) as { session_id?: string; apiKeySource?: string; claude_code_version?: string };
      expect(init?.session_id).toBe(sessionId);
      report('init', {
        sessionIdMatches: init?.session_id === sessionId,
        apiKeySource: init?.apiKeySource,
        version: init?.claude_code_version,
      });

      // (b) is the user message echoed back, and under which uuid?
      const sentUuid = all.find((i) => i.kind === 'user')?.id;
      const echoes = adapter.raw
        .filter(
          (m) => m.type === 'user' && !(m as { parent_tool_use_id?: unknown }).parent_tool_use_id,
        )
        .map((m) => ({
          uuid: (m as { uuid?: string }).uuid,
          sameUuid: (m as { uuid?: string }).uuid === sentUuid,
          isReplay: (m as { isReplay?: boolean }).isReplay,
        }));
      report('userEcho', { sentUuid, echoes });
      // Whatever the CLI does, the chat must show the message once.
      expect(all.filter((i) => i.kind === 'user')).toHaveLength(1);

      report('rawTypes', [
        ...new Set(
          adapter.raw.map((m) => {
            const sub = (m as { subtype?: string }).subtype;
            return sub ? `${m.type}/${sub}` : m.type;
          }),
        ),
      ]);

      // Auth this session runs on (no Threadgarden key set).
      const account = await adapter.sessions[0]!.accountInfo();
      report('accountInfo(no key)', {
        apiProvider: account.apiProvider,
        apiKeySource: account.apiKeySource,
        tokenSource: account.tokenSource,
        subscriptionType: account.subscriptionType,
        hasEmail: account.email !== undefined,
      });
      expect(account.apiProvider).toBeDefined();
    } finally {
      live.end();
      await live.whenEnded();
    }
  });

  it('surfaces a real startup failure as an explained, failed chat (no API call)', async () => {
    // An unparsable proxy URL makes the CLI refuse to start before contacting the API.
    const s = LiveSession.create(
      dir,
      { text: 'hi' },
      {
        adapter: new RealAdapter(),
        registry,
        claudePath,
        env: { ...buildSessionEnv(process.env, null), HTTPS_PROXY: 'not a url' },
        permissionMode: 'default',
        now: Date.now,
        emit: () => {},
      },
    );
    await waitFor(() => s.status === 'failed', 60_000, 'the startup failure');
    await s.whenEnded();
    expect(s.startupFailure).toMatchObject({ reason: 'proxy_invalid', setup: false });
    report('startupFailure', s.startupFailure);
  });

  it('reports which auth a session would use with ANTHROPIC_API_KEY set (no prompt sent)', async () => {
    const adapter = new RealAdapter();
    const session = adapter.start({
      cwd: dir,
      sessionId: randomUUID(),
      env: buildSessionEnv(process.env, DUMMY_KEY),
      claudePath,
      permissionMode: 'default',
      canUseTool: async () => ({ behavior: 'deny', message: 'Threadgarden real test' }),
    });
    try {
      const account = await session.accountInfo();
      report('accountInfo(dummy key)', {
        apiProvider: account.apiProvider,
        apiKeySource: account.apiKeySource,
        tokenSource: account.tokenSource,
        subscriptionType: account.subscriptionType,
        hasEmail: account.email !== undefined,
      });
      expect(account.apiKeySource).toBe('ANTHROPIC_API_KEY');
    } finally {
      session.close();
    }
  });
});
