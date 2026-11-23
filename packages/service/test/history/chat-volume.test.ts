import { expect, it, vi } from 'vitest';
import { Catalog, type LiveChat } from '../../src/history/catalog.js';
import { openDb } from '../../src/history/db.js';
import { Indexer } from '../../src/history/indexer.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';

const reply = (id: string, usage?: Record<string, number>, extra = {}): SessionMessage =>
  ({
    uuid: id,
    type: 'assistant',
    session_id: 's',
    parent_tool_use_id: null,
    timestamp: '2026-11-23T10:00:00Z',
    message: { id, role: 'assistant', model: 'test-model', content: [], usage },
    ...extra,
  }) as unknown as SessionMessage;

it('carries indexed token totals through history, project and live summaries without rereading history', async () => {
  const db = openDb(':memory:');
  try {
    const adapter = new FakeAdapter();
    const main = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
    };
    const child = {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    };
    adapter.sessions.set('s', {
      info: {
        sessionId: 's',
        summary: 'Chat',
        cwd: '/work',
        lastModified: Date.now(),
        fileSize: 100,
      },
      messages: [
        reply('main', { output_tokens: 5 }),
        reply('main', main),
        reply('child', child, { parent_tool_use_id: 'agent' }),
      ],
    });
    const read = vi.spyOn(adapter, 'getSessionMessages');
    const indexer = new Indexer(adapter, db, () => {}, {
      platform: 'linux',
      gitCommonDir: () => null,
    });
    await indexer.fullSync();
    let live: LiveChat[] = [];
    const catalog = new Catalog({ db, live: { list: () => live } });
    expect(catalog.summary('s')?.totalTokens).toBe(560);
    expect(catalog.list({ kind: 'active' }, undefined, 50).items[0]?.totalTokens).toBe(560);
    const projectId = catalog.summary('s')!.projectId;
    expect(catalog.list({ kind: 'project', projectId }, undefined, 50).items[0]?.totalTokens).toBe(
      560,
    );
    live = [{ sessionId: 's', cwd: '/work', status: 'working', live: true }];
    expect(catalog.summaries(['s'])[0]?.totalTokens).toBe(560);
    expect(catalog.list({ kind: 'running' }, undefined, 50).items[0]?.totalTokens).toBe(560);
    expect(read).toHaveBeenCalledTimes(1);
    const session = adapter.sessions.get('s')!;
    session.messages.push(reply('next', { input_tokens: 10, output_tokens: 10 }));
    session.info.lastModified++;
    await indexer.refresh(['s']);
    expect(catalog.summary('s')?.totalTokens).toBe(580);
  } finally {
    db.close();
  }
});

it('leaves token volume absent when history has no reported usage', async () => {
  const db = openDb(':memory:');
  try {
    const adapter = new FakeAdapter();
    adapter.sessions.set('s', {
      info: { sessionId: 's', summary: 'Chat', cwd: '/work', lastModified: Date.now() },
      messages: [reply('no-usage')],
    });
    await new Indexer(adapter, db, () => {}).fullSync();
    expect(new Catalog({ db }).summary('s')).not.toHaveProperty('totalTokens');
  } finally {
    db.close();
  }
});
