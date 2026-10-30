/**
 * Opt-in end-to-end suite: the whole pahub service (`startService` with the
 * real Agent SDK adapter) against the installed `claude`, the user's own
 * login and their real Claude config dir, driven over the WebSocket like the
 * UI drives it. Run with `pnpm --filter @pahub/service test:real`
 * (PAHUB_REAL=1); never part of `pnpm test` or CI.
 *
 * Every chat runs in a fresh temp git repo with tiny prompts; the only tool
 * the model may use is one harmless `echo` into that repo, and no bypass mode
 * is ever used. pahub's data dir is a temp dir too.
 *
 * Read-only check: the real config dir cannot be swapped for a temp one
 * (the real `claude` needs the real login), so the suite snapshots every file
 * under `<config>/projects/` (except the temp repos' own project dirs, which
 * hold transcripts Claude Code writes for the sessions started here) plus
 * `settings.json` before the service starts and after it shut down, and
 * compares them (`claude-snapshot.ts`). It never writes under the config dir
 * itself, and leaves the temp repos' transcripts in place: they are Claude
 * Code's data.
 *
 * Observations are printed with a `[pahub-real]` prefix for the docs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatItem, ChatSummary } from '@pahub/protocol';
import { resolveClaudeConfigDir } from '../../src/config.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { findInstalledClaude, type ClaudeFound } from '../../src/sdk/claude-path.js';
import { RealAdapter } from '../../src/sdk/real-adapter.js';
import { TestClient } from '../e2e/ws-client.js';
import {
  compareTree,
  snapshotFile,
  snapshotTree,
  type FileEntry,
  type Snapshot,
} from './claude-snapshot.js';

const REAL = process.env.PAHUB_REAL === '1';
/** Files modified this long before the run belong to sessions running elsewhere. */
const ACTIVE_WINDOW_MS = 15 * 60_000;
const TURN_MS = 180_000;
const ECHO = 'echo pahub-real-test > pahub-real.txt';
const MAGIC = 'quokka-5150';

type Opened = {
  summary: ChatSummary;
  items: ChatItem[];
  hasMore: boolean;
  seq: number;
};

const report = (label: string, value: unknown): void => {
  console.log(`[pahub-real] ${label}: ${JSON.stringify(value)}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A temp-repo project dir of this suite (Claude Code names it after the encoded cwd). */
const isSuiteProjectDir = (rel: string): boolean =>
  (rel.split(path.sep)[0] ?? '').includes('pahub-real-');

const texts = (items: ChatItem[], kind: 'user' | 'assistantText'): string[] =>
  items.flatMap((i) =>
    i.kind === kind
      ? [i.kind === 'user' ? i.text : i.kind === 'assistantText' ? i.markdown : '']
      : [],
  );

describe.skipIf(!REAL)('pahub service against real Claude Code (PAHUB_REAL=1)', () => {
  let claude: ClaudeFound;
  let repo = '';
  let data = '';
  let claudeDir = '';
  let projectsBefore: Snapshot = new Map();
  let settingsBefore: FileEntry | undefined;
  let activeSince = 0;
  let svc: ServiceHandle | undefined;
  let c: TestClient;
  let closed: Promise<void> = Promise.resolve();
  let chatId = '';
  /** The user item pahub showed for the first prompt while the chat was live. */
  let firstUser: ChatItem | undefined;

  const open = (sessionId: string, tail = 500): Promise<Opened> =>
    c.call<Opened>('chat.open', { sessionId, tail });

  /**
   * Polls the chat until its turn is over (idle, nothing pending). Pending
   * permission requests go to `decide`; anything it does not answer is denied.
   */
  const settle = async (
    sessionId: string,
    decide: (p: Extract<ChatItem, { kind: 'permissionRequest' }>) => 'allow' | 'deny' = () =>
      'deny',
  ): Promise<Opened> => {
    const deadline = Date.now() + TURN_MS;
    for (;;) {
      const o = await open(sessionId);
      const pending = o.items.filter(
        (i): i is Extract<ChatItem, { kind: 'permissionRequest' }> =>
          i.kind === 'permissionRequest' && i.state === 'pending',
      );
      for (const p of pending) {
        const decision = decide(p);
        report('permissionRequest', { toolName: p.toolName, input: p.input, decision });
        await c.call('chat.respond', { sessionId, requestId: p.requestId, decision });
      }
      const status = o.summary.status;
      if (status === 'failed') {
        throw new Error(
          `chat failed: ${JSON.stringify(o.items.filter((i) => i.kind === 'system'))}`,
        );
      }
      if (pending.length === 0 && status === 'idle') return o;
      if (Date.now() > deadline) throw new Error(`turn did not finish (status ${status})`);
      await sleep(250);
    }
  };

  /** Sends to a chat; retries while resume safety still sees the just-ended process. */
  const send = async (sessionId: string, text: string): Promise<number> => {
    const started = Date.now();
    for (;;) {
      const r = await c.raw('chat.send', { sessionId, text });
      if (!r.error) return Date.now() - started;
      if (r.error.code !== 'RESUME_BLOCKED' || Date.now() - started > 30_000) {
        throw new Error(`chat.send: ${r.error.code}: ${r.error.message}`);
      }
      report('resumeBlockedRetry', r.error.message);
      await sleep(1_000);
    }
  };

  beforeAll(async () => {
    const found = await findInstalledClaude(null);
    if (!('path' in found)) throw new Error(`claude not usable: ${found.detail}`);
    claude = found;
    report('claude', { version: found.version, ext: path.extname(found.path) });

    repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'pahub-real-svc-')));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(path.join(repo, 'notes.txt'), `The pahub magic word is ${MAGIC}.\n`);
    data = mkdtempSync(path.join(os.tmpdir(), 'pahub-real-data-'));

    claudeDir = resolveClaudeConfigDir(process.env, os.homedir());
    const started = Date.now();
    activeSince = started - ACTIVE_WINDOW_MS;
    projectsBefore = await snapshotTree(path.join(claudeDir, 'projects'), isSuiteProjectDir);
    settingsBefore = await snapshotFile(path.join(claudeDir, 'settings.json'));
    report('snapshotBefore', { files: projectsBefore.size, ms: Date.now() - started });

    svc = await startService({
      dataDir: data,
      adapter: new RealAdapter(),
      claude,
      installSignalHandlers: false,
    });
    const handle = svc;
    closed = new Promise<void>((r) => handle.onClosed(r));
    c = await TestClient.connect(svc.port, svc.token);
  }, 300_000);

  afterAll(async () => {
    await c?.close().catch(() => {});
    await svc?.close().catch(() => {});
    // A closed session's `claude` exits a moment later; until then Windows keeps its cwd busy.
    for (const dir of [repo, data]) {
      if (!dir) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt >= 40) {
            report('cleanup', `left ${dir}: ${String(err)}`);
            break;
          }
          await sleep(250);
        }
      }
    }
  }, 60_000);

  it('indexes the real history through the SDK', async () => {
    const started = Date.now();
    let status = { done: 0, total: 0 };
    while (Date.now() - started < 600_000) {
      status = (await c.call<{ indexing: { done: number; total: number } }>('system.status', {}))
        .indexing;
      if (status.total > 0 && status.done >= status.total) break;
      await sleep(1_000);
    }
    const counts = await c.call<{ all: number }>('places.counts', {});
    report('index', { ...status, all: counts.all, ms: Date.now() - started });
    expect(status.total).toBeGreaterThan(0);
    expect(status.done).toBe(status.total);
    expect(counts.all).toBeGreaterThan(0);
  }, 660_000);

  it('creates a chat and round-trips a Bash permission request', async () => {
    const prompt =
      `Use the Bash tool to run exactly this command: ${ECHO}\n` +
      'Then reply with the single word done.';
    ({ sessionId: chatId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: repo,
      text: prompt,
      permissionMode: 'default',
    }));
    let asked = false;
    const o = await settle(chatId, (p) => {
      const command = String((p.input as { command?: unknown }).command ?? '');
      if (p.toolName === 'Bash' && command.includes('echo pahub-real-test')) {
        asked = true;
        return 'allow';
      }
      return 'deny';
    });
    expect(asked).toBe(true);
    expect(readFileSync(path.join(repo, 'pahub-real.txt'), 'utf8')).toContain('pahub-real-test');
    expect(
      o.items.some((i) => i.kind === 'toolCall' && i.name === 'Bash' && i.status === 'ok'),
    ).toBe(true);
    // History (transcript so far) and the live items are merged without duplicates.
    const users = o.items.filter((i) => i.kind === 'user');
    report(
      'liveUserItems',
      users.map((u) => ({ id: u.id, text: texts([u], 'user')[0] })),
    );
    expect(users.filter((u) => texts([u], 'user')[0] === prompt)).toHaveLength(1);
    firstUser = users.find((u) => texts([u], 'user')[0] === prompt);
    expect(firstUser).toBeDefined();
  });

  it('keeps the uuid pahub assigns to a sent user message in the transcript', async () => {
    await c.call('chat.end', { sessionId: chatId });
    const o = await open(chatId);
    expect(o.summary.status).toBe('history');
    const historyUsers = o.items.filter((i) => i.kind === 'user');
    const same = historyUsers.find((u) => u.id === firstUser!.id);
    report('transcriptUserUuid', {
      sentId: firstUser!.id,
      historyIds: historyUsers.map((u) => u.id),
      kept: same !== undefined,
    });
    expect(same && texts([same], 'user')[0]).toBe(texts([firstUser!], 'user')[0]);
  });

  it('resumes the chat after chat.end', async () => {
    const check = await c.call<{ status: string; reason: string }>('chat.resumeCheck', {
      sessionId: chatId,
    });
    report('resumeCheckAfterEnd', check);
    const waited = await send(
      chatId,
      'What text did the command you ran write into the file? Reply with only that text. Do not use any tools.',
    );
    report('resumeSendMs', waited);
    const o = await settle(chatId);
    const replies = texts(o.items, 'assistantText');
    expect(replies.at(-1)).toContain('pahub-real-test');
    // The first prompt (now history) and the resumed process's items are not duplicated.
    expect(o.items.filter((i) => i.kind === 'user' && i.id === firstUser!.id)).toHaveLength(1);
  });

  it('expands an @file mention like the CLI does', async () => {
    await send(
      chatId,
      'What is the magic word in @notes.txt? Reply with only the word. Do not use any tools.',
    );
    const o = await settle(chatId); // any tool request is denied: the content must come from the mention
    const last = o.items.slice(o.items.findLastIndex((i) => i.kind === 'user'));
    report(
      'mentionItems',
      last.map((i) => (i.kind === 'toolCall' ? `toolCall:${i.name}` : i.kind)),
    );
    expect(texts(last, 'assistantText').join(' ')).toContain(MAGIC);
  });

  it('forks from a user message sent by this process', async () => {
    const o = await open(chatId);
    const target = o.items.filter((i) => i.kind === 'user').at(-1)!;
    const fork = await c.call<{ sessionId: string }>('chat.fork', {
      sessionId: chatId,
      upToItemId: target.id,
    });
    expect(fork.sessionId).not.toBe(chatId);
    const f = await open(fork.sessionId);
    const forkUsers = texts(f.items, 'user');
    report('fork', {
      targetId: target.id,
      originalItems: o.items.length,
      forkItems: f.items.length,
      forkUserTexts: forkUsers.map((t) => t.slice(0, 40)),
      lastForkKind: f.items.at(-1)?.kind,
    });
    expect(forkUsers).toContain(texts([firstUser!], 'user')[0]);
    expect(forkUsers.at(-1)).toBe(texts([target], 'user')[0]);
    // Nothing after the target message: the reply that followed it is not in the fork.
    expect(texts(f.items, 'assistantText').join(' ')).not.toContain(MAGIC);
  });

  it('dispatches /compact', async () => {
    await send(chatId, '/compact');
    const o = await settle(chatId);
    const label = (i: ChatItem): string =>
      i.kind === 'system' || i.kind === 'user' ? `${i.kind}:${i.text.slice(0, 50)}` : i.kind;
    const isSummary = (i: ChatItem) => i.kind === 'user' && i.text.startsWith('This session is');
    const command = o.items.findLastIndex((i) => i.kind === 'user' && i.text === '/compact');
    report('compactItems', o.items.slice(command).map(label));
    expect(command).toBeGreaterThanOrEqual(0);
    const after = o.items.slice(command);
    expect(after.filter((i) => i.kind === 'compactBoundary')).toHaveLength(1);
    expect(after.some(isSummary)).toBe(false);
    expect(after.some((i) => i.kind === 'system' && i.text === 'Compacted')).toBe(true);
    // Once ended, the transcript as the SDK reads it: the summary becomes the
    // boundary, the command entry the typed command.
    await c.call('chat.end', { sessionId: chatId });
    const h = await open(chatId);
    report('compactHistory', h.items.map(label));
    expect(h.items.filter((i) => i.kind === 'compactBoundary')).toHaveLength(1);
    expect(h.items.some(isSummary)).toBe(false);
    expect(h.items.some((i) => i.kind === 'user' && i.text === '/compact')).toBe(true);
  });

  it('opens and annotates real history without touching it', async () => {
    const page = await c.call<{ items: ChatSummary[] }>('sessions.list', {
      place: { kind: 'all' },
      limit: 200,
    });
    // An old chat of another project: nothing else writes its transcript meanwhile.
    const old = page.items.find(
      (s) =>
        s.sessionId !== chatId &&
        !s.external &&
        s.status === 'history' &&
        s.lastActivity < activeSince - 60 * 60_000,
    );
    expect(old).toBeDefined();
    const o = await open(old!.sessionId, 50);
    if (o.hasMore && o.items[0]) {
      await c.call('chat.older', {
        sessionId: old!.sessionId,
        beforeItemId: o.items[0].id,
        limit: 50,
      });
    }
    await c.call('meta.update', {
      sessionId: old!.sessionId,
      customTitle: 'pahub real test',
      pinned: true,
    });
    await c.call('meta.update', { sessionId: chatId, customTitle: 'pahub real chat' });
    const renamed = await c.call<{ items: ChatSummary[] }>('sessions.list', {
      place: { kind: 'all' },
      query: 'pahub real test',
      limit: 10,
    });
    expect(renamed.items.some((s) => s.sessionId === old!.sessionId)).toBe(true);
    await c.call('search.quick', { query: 'magic word', limit: 10 });
    await c.call('chat.resumeCheck', { sessionId: old!.sessionId });
    report('history', { items: o.items.length, hasMore: o.hasMore });
  });

  it('left the Claude config dir untouched', async () => {
    await c.call('service.shutdown', { stopAll: true });
    await closed;
    const projects = path.join(claudeDir, 'projects');
    const after = await snapshotTree(projects, isSuiteProjectDir);
    const result = await compareTree(projects, projectsBefore, after, activeSince);
    report('readOnly', {
      files: after.size,
      violations: result.violations,
      appendedByOtherSessions: result.appended.length,
      addedByOtherSessions: result.added.length,
    });
    expect(result.violations).toEqual([]);
    expect(await snapshotFile(path.join(claudeDir, 'settings.json'))).toEqual(settingsBefore);
  }, 300_000);
});
