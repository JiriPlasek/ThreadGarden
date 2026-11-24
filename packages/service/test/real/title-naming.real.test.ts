/** A disposable native title request, never a conversation in the user's Codex history. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ChatTitles, type TitleMessage } from '../../src/chat/titles.js';
import { openDb } from '../../src/history/db.js';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { useThrowawayCodexHome } from './codex-home.js';

useThrowawayCodexHome();

it.skipIf(process.env.THREADGARDEN_TEST_CODEX_INFERENCE !== '1')(
  'defers an unclear name, uses later clarification and keeps an adequate title',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tg-title-naming-'));
    const db = openDb(path.join(root, 'titles.db'));
    const adapter = new MultiAdapter(new FakeAdapter(), new CodexAdapter(path.join(root, 'codex')));
    const id = 'codex-11111111-2222-4333-8444-555555555555';
    const messages: TitleMessage[] = [
      { id: 'u1', role: 'user', text: 'Hello!' },
      { id: 'a1', role: 'assistant', text: 'Hello! What would you like help with?' },
    ];
    const titles = new ChatTitles({
      db,
      adapter,
      enabled: () => true,
      run: () => ({ claudePath: '', env: process.env }),
      conversation: async () => messages,
      titleChanged: () => {},
      emit: () => {},
    });
    try {
      titles.started(id, root, 'Hello!');
      expect(await titles.regenerate(id, root)).toEqual({ title: 'Hello!', changed: false });
      messages.push(
        {
          id: 'u2',
          role: 'user',
          text: 'Fix the Safari OAuth login redirect: the callback loses returnUrl. The goal of this chat is correcting that bug.',
        },
        {
          id: 'a2',
          role: 'assistant',
          text: 'Preserve returnUrl through the callback and cover the Safari redirect with a regression test.',
        },
      );
      const named = await titles.regenerate(id, root);
      expect(named.changed).toBe(true);
      expect(named.title).toMatch(/Safari|OAuth|redirect|returnUrl/i);
      expect(named.title.length).toBeLessThanOrEqual(80);
      expect(await titles.regenerate(id, root)).toEqual({ title: named.title, changed: false });
    } finally {
      titles.dispose();
      adapter.dispose();
      db.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
