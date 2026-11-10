/** Opt-in CLI checks. Inference additionally needs THREADGARDEN_TEST_CODEX_INFERENCE=1. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveSession } from '../../src/chat/live-session.js';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { MemoryRegistry } from '../chat/live-helpers.js';

describe('installed Codex CLI', () => {
  it('initializes app-server and reads its model catalog', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-codex-catalog-'));
    try {
      const models = await new CodexAdapter(dir).models(process.env);
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((model) => model.value.startsWith('codex:'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it.skipIf(process.env.THREADGARDEN_TEST_CODEX_INFERENCE !== '1')(
    'streams a turn and resumes its remembered context in a fresh process',
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'tg-codex-inference-'));
      const marker = 'threadgarden-codex-spring-823';
      let session: LiveSession | undefined;
      const options = {
        adapter: new MultiAdapter(new FakeAdapter(), new CodexAdapter(path.join(dir, 'journal'))),
        registry: new MemoryRegistry(),
        claudePath: '',
        env: process.env,
        now: Date.now,
        emit: () => {},
        model: 'codex:default',
        onError: () => {},
      };
      const wait = async (running: LiveSession): Promise<void> => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline && !['idle', 'failed'].includes(running.status)) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const errors = running.snapshot(100).items.filter((item) => item.kind === 'system');
        expect(running.status, JSON.stringify(errors)).toBe('idle');
      };
      try {
        session = LiveSession.create(
          dir,
          { text: `Remember marker ${marker}. Reply only CODEX_OK. Do not use tools.` },
          options,
        );
        await wait(session);
        expect(session.header.contextUsage?.max).toBeGreaterThan(0);
        expect(session.header.contextUsage?.used).toBeGreaterThan(0);
        expect(session.header.runtime).toBe('codex');
        expect(session.header.costUsd).toBeUndefined();
        const usage = await session.readUsage()?.();
        expect(usage).toMatchObject({ account: { runtime: 'codex' } });
        expect(session.snapshot(100).items).toContainEqual(
          expect.objectContaining({
            kind: 'assistantText',
            markdown: expect.stringContaining('CODEX_OK'),
          }),
        );
        const id = session.sessionId;
        session.end();
        await session.whenEnded();
        // No model/permission options supplied on restart: they come from the saved record.
        session = LiveSession.resume(id, dir, {
          ...options,
          adapter: new MultiAdapter(new FakeAdapter(), new CodexAdapter(path.join(dir, 'journal'))),
        });
        session.send({
          text: 'What marker did I ask you to remember? Reply with only the marker. Do not use tools.',
        });
        await wait(session);
        expect(session.snapshot(100).items).toContainEqual(
          expect.objectContaining({
            kind: 'assistantText',
            markdown: expect.stringContaining(marker),
          }),
        );
        expect(session.snapshot(100).items.some((item) => item.kind === 'toolCall')).toBe(false);
      } finally {
        session?.end();
        await session?.whenEnded();
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
  );
});
