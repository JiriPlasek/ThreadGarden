/**
 * pahub never writes to Claude Code's data (spec §2 anti-goal 2, §5.1): a full
 * service lifecycle against a fixture `CLAUDE_CONFIG_DIR` leaves every path in
 * it byte-for-byte, size and mtime identical.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readDiscovery } from '../../src/discovery.js';
import { startService } from '../../src/main.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { assistantText, init, result } from '../chat/live-helpers.js';
import { TestClient, chatStatus, eventually } from './ws-client.js';

type Entry = { kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; hash?: string };

/** Every path under `root` with its size, mtime and (files) content hash; dirs list children. */
const snapshot = async (root: string): Promise<Record<string, Entry & { children?: string[] }>> => {
  const out: Record<string, Entry & { children?: string[] }> = {};
  const walk = async (p: string): Promise<void> => {
    const st = await lstat(p);
    const key = relative(root, p) || '.';
    if (st.isDirectory()) {
      const names = (await readdir(p)).sort();
      out[key] = { kind: 'dir', size: st.size, mtimeMs: st.mtimeMs, children: names };
      for (const n of names) await walk(join(p, n));
    } else if (st.isFile()) {
      const hash = createHash('sha256')
        .update(await readFile(p))
        .digest('hex');
      out[key] = { kind: 'file', size: st.size, mtimeMs: st.mtimeMs, hash };
    } else {
      out[key] = { kind: 'other', size: st.size, mtimeMs: st.mtimeMs };
    }
  };
  await walk(root);
  return out;
};

let dir: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pahub-ro-'));
  savedEnv = process.env.CLAUDE_CONFIG_DIR;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

const historyMessage = (sessionId: string, uuid: string, text: string): SessionMessage =>
  ({
    type: 'user',
    uuid,
    session_id: sessionId,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    parent_agent_id: null,
  }) as SessionMessage;

it('a full service lifecycle leaves the Claude config dir untouched', async () => {
  // Fixture: what Claude Code keeps in its config dir.
  const claude = join(dir, 'claude');
  const project = join(dir, 'work', 'proj-a');
  await mkdir(project, { recursive: true });
  const sessions = ['s1', 's2', 's3'];
  for (const [i, id] of sessions.entries()) {
    const pdir = join(claude, 'projects', i < 2 ? '-work-proj-a' : '-work-proj-b');
    await mkdir(pdir, { recursive: true });
    await writeFile(join(pdir, `${id}.jsonl`), `{"placeholder":"${id}"}\n`);
  }
  await writeFile(join(claude, 'settings.json'), '{"permissions":{"allow":[]}}\n');
  await mkdir(join(claude, 'jobs'), { recursive: true });
  await writeFile(join(claude, 'jobs', 'job-1.json'), '{"id":"job-1"}\n');
  await writeFile(join(claude, 'CLAUDE.md'), '# user memory\n');
  const before = await snapshot(claude);

  const adapter = new FakeAdapter();
  for (const id of sessions) {
    adapter.sessions.set(id, {
      info: { sessionId: id, summary: `Chat ${id}`, lastModified: 1, fileSize: 10, cwd: project },
      messages: [historyMessage(id, `${id}-u0`, 'hello'), historyMessage(id, `${id}-u1`, 'again')],
    });
  }

  // `CLAUDE_CONFIG_DIR` is honoured (no explicit claudeConfigDir option).
  process.env.CLAUDE_CONFIG_DIR = claude;
  const data = join(dir, 'data');
  const svc = await startService({
    dataDir: data,
    adapter,
    claude: { path: '/bin/claude', version: '2.1.314' },
    externalRun: async () => '[]',
    installSignalHandlers: false,
  });
  const closed = new Promise<void>((r) => svc.onClosed(r));
  const c = await TestClient.connect(svc.port, svc.token);
  try {
    // index + watch
    await eventually(async () => (await c.call<{ all: number }>('places.counts', {})).all === 3);
    await c.call('sessions.list', { place: { kind: 'all' }, limit: 50 });
    await c.call('search.quick', { query: 'chat', limit: 10 });
    // open
    await c.call('chat.open', { sessionId: 's1', tail: 50 });
    await c.call('chat.older', { sessionId: 's1', beforeItemId: 's1-u1', limit: 10 });
    // create + stream
    const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
      cwd: project,
      text: 'new chat',
    });
    const fake = adapter.lastSession();
    fake.emit(init(sessionId));
    fake.emit(assistantText('a1', 'reply'));
    fake.emit(result('r1'));
    await c.waitFor(chatStatus(sessionId, 'idle'));
    // resume a history chat
    await c.call('chat.resumeCheck', { sessionId: 's2' });
    await c.call('chat.send', { sessionId: 's2', text: 'continue' });
    // fork
    await c.call('chat.fork', { sessionId: 's1', upToItemId: 's1-u0' });
    // pahub-side metadata, drafts, settings
    await c.call('meta.update', { sessionId: 's3', customTitle: 'Renamed in pahub', pinned: true });
    await c.call('projects.list', {});
    await c.call('drafts.set', { key: 's1', text: 'draft' });
    await c.call('settings.set', { idleReclaimMinutes: 5 });
    await c.call('auth.setApiKey', { key: 'sk-test' });
    // stop all + shutdown
    expect(await c.call('work.stopAll', {})).toEqual({ stopped: 2 });
    await c.call('service.shutdown', { stopAll: true });
    await closed;
  } finally {
    await c.close();
    await svc.close();
  }
  expect(await readDiscovery(data)).toBeNull();

  expect(await snapshot(claude)).toEqual(before);
});
