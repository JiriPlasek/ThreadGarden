import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ChatSummary, Project } from '@threadgarden/protocol';
import { projectIdFor } from '../src/history/projects.js';
import { openDb } from '../src/history/db.js';
import { startService, type ServiceHandle } from '../src/main.js';
import { FakeAdapter } from '../src/testing/fake-adapter.js';
import { assistantText, settle, streamEvent } from './chat/live-helpers.js';

const call = <T>(svc: ServiceHandle, method: string, params: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${svc.port}`, `threadgarden.${svc.token}`);
    ws.once('error', reject);
    ws.on('message', (data) => {
      const reply = JSON.parse(String(data)) as { id?: number; result: T; error?: unknown };
      if (reply.id !== 1) return;
      ws.close();
      if (reply.error) reject(new Error(JSON.stringify(reply.error)));
      else resolve(reply.result);
    });
    ws.once('open', () => ws.send(JSON.stringify({ id: 1, method, params })));
  });

it('wires user sends and permission handoffs to durable sidebar order through startService', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'threadgarden-sidebar-'));
  const adapter = new FakeAdapter();
  let now = 1000;
  let svc: ServiceHandle | undefined;
  try {
    const a = join(dir, 'alpha');
    const b = join(dir, 'beta');
    await mkdir(a);
    await mkdir(b);
    await mkdir(join(dir, 'data'));
    const seed = openDb(join(dir, 'data', 'threadgarden.db'));
    for (const path of [a, b])
      seed.upsertProject({
        projectId: projectIdFor(path, process.platform, () => null),
        path,
        displayName: path,
      });
    seed.close();
    svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude-missing'),
      adapter,
      claude: { path: '/fake/claude', version: '2.1.314' },
      externalRun: async () => '[]',
      clock: () => now,
      installSignalHandlers: false,
    });
    const first = await call<{ sessionId: string }>(svc, 'chat.create', { cwd: a, text: 'first' });
    const firstSession = adapter.lastSession();
    now = 2000;
    const second = await call<{ sessionId: string }>(svc, 'chat.create', {
      cwd: b,
      text: 'second',
    });
    const secondSession = adapter.lastSession();
    const lists = async () => {
      const chats = await call<{ items: ChatSummary[] }>(svc!, 'sessions.list', {
        place: { kind: 'active' },
        limit: 50,
      });
      const projects = await call<Project[]>(svc!, 'projects.list', {});
      return { chats: chats.items.map((c) => c.sessionId), projects: projects.map((p) => p.path) };
    };
    expect(await lists()).toEqual({ chats: [second.sessionId, first.sessionId], projects: [b, a] });

    now = 3000;
    expect(
      await call(svc, 'chat.send', { sessionId: first.sessionId, text: 'queued prompt' }),
    ).toEqual({ queued: true });
    expect(await lists()).toEqual({ chats: [first.sessionId, second.sessionId], projects: [a, b] });
    const db = openDb(join(dir, 'data', 'threadgarden.db'));
    try {
      expect(db.sidebarActivityOf(first.sessionId)?.userAt).toBe(3000);
      now = 4000;
      secondSession.emit(assistantText('reply', 'assistant output'));
      secondSession.emit(
        streamEvent('tool-stream', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool', name: 'Read', input: {} },
        }),
      );
      secondSession.emit(
        streamEvent('text-stream', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'more output' },
        }),
      );
      await settle();
      expect(db.sidebarActivityOf(second.sessionId)?.userAt).toBe(2000);
      expect(await lists()).toEqual({
        chats: [first.sessionId, second.sessionId],
        projects: [a, b],
      });

      now = 5000;
      const controller = new AbortController();
      const permission = secondSession.requestPermission(
        'Read',
        {
          file_path: join(b, 'example.txt'),
        },
        { signal: controller.signal },
      );
      await settle();
      expect(db.sidebarActivityOf(second.sessionId)?.attentionAt).toBe(5000);
      expect(await lists()).toEqual({
        chats: [second.sessionId, first.sessionId],
        projects: [b, a],
      });
      // Abort the waiting permission before stopping the service.
      controller.abort();
      await permission;
      expect(db.sidebarActivityOf(first.sessionId)?.userAt).toBe(3000);
      expect(firstSession.sent).toHaveLength(2);
    } finally {
      db.close();
    }
  } finally {
    await svc?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
