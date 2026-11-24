/** One native continuation in disposable history; no inference from the source provider. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { LiveSession } from '../../src/chat/live-session.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import { FakeAdapter } from '../../src/testing/fake-adapter.js';
import { MultiAdapter } from '../../src/sdk/multi-adapter.js';
import { CodexAdapter } from '../../src/sdk/codex-adapter.js';
import type { SessionMessage } from '../../src/sdk/adapter.js';
import { eventually } from '../e2e/ws-client.js';
import { useThrowawayCodexHome } from './codex-home.js';

useThrowawayCodexHome();
it.skipIf(process.env.THREADGARDEN_TEST_CODEX_INFERENCE !== '1')(
  'Codex reads an exported Claude history outside the project and continues its last task',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tg-continue-real-'));
    const project = path.join(root, 'project');
    const dataDir = path.join(root, 'data');
    const claudeDir = path.join(root, 'claude-fixture');
    const marker = 'HANDOFF_' + randomUUID();
    let svc: ServiceHandle | undefined;
    let targetSession: LiveSession | undefined;
    const claude = new FakeAdapter();
    const adapter = new MultiAdapter(claude, new CodexAdapter(path.join(dataDir, 'codex')));
    try {
      await mkdir(project);
      await mkdir(claudeDir);
      await writeFile(path.join(project, 'proof.txt'), marker);
      const source = randomUUID();
      claude.sessions.set(source, {
        info: {
          sessionId: source,
          summary: 'Read the proof phrase',
          cwd: project,
          lastModified: 1,
          fileSize: 100,
        },
        messages: [
          {
            type: 'user',
            uuid: 'u',
            session_id: source,
            message: {
              role: 'user',
              content:
                'The remaining task is to read proof.txt in the working folder and reply with exactly its contents. Do not change any files.',
            },
            parent_tool_use_id: null,
          },
          {
            type: 'assistant',
            uuid: 'a',
            session_id: source,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'I hit my usage limit before I could read proof.txt. The task remains unfinished.',
                },
              ],
            },
            parent_tool_use_id: null,
          },
        ] as SessionMessage[],
      });
      svc = await startService({
        dataDir,
        claudeConfigDir: claudeDir,
        adapter,
        claude: { path: '/unused/claude', version: '2.1.314' },
        externalRun: async () => '[]',
        installSignalHandlers: false,
      });
      const service = svc;
      const call = async (method: string, params: unknown) => {
        const reply = await service.router.dispatch(
          { id: 1, method, params },
          { clientId: 'test', origin: 'local' },
        );
        if ('error' in reply) throw new Error(JSON.stringify(reply.error));
        return reply.result;
      };
      await call('settings.set', { autoTitles: false });
      await eventually(
        async () =>
          ((await call('sessions.summaries', { sessionIds: [source] })) as { items: unknown[] })
            .items.length === 1,
        10_000,
      );
      const target = 'codex-' + randomUUID();
      await call('chat.continue', { sessionId: source, targetSessionId: target, stopSource: true });
      targetSession = service.host!.get(target);
      await eventually(
        () => ['idle', 'failed', 'needsYou'].includes(service.host!.get(target)!.status),
        120_000,
      );
      const running = service.host!.get(target)!;
      const items = running.snapshot(100).items;
      expect(running.status, JSON.stringify(items)).toBe('idle');
      expect(
        items.some((item) => item.kind === 'assistantText' && item.markdown.includes(marker)),
      ).toBe(true);
      expect(await readFile(path.join(project, 'proof.txt'), 'utf8')).toBe(marker);
      expect(claude.oneShots).toHaveLength(0);
      expect(claude.started).toHaveLength(0);
    } finally {
      targetSession?.end();
      await targetSession?.whenEnded();
      await svc?.close();
      adapter.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  },
  180_000,
);
