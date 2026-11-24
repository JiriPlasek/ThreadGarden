import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import { LOCAL, setup, summary } from '../layout/harness';
import { fill } from './helpers';

const SID = 'codex-11111111-2222-4333-8444-555555555555';

const open = async (external = false) => {
  const env = await setup((server) => {
    Object.assign(server.handlers, {
      'chat.open': () => ({
        summary: summary(SID, {
          status: 'idle',
          live: true,
          external: external ? { kind: 'codex' } : null,
        }),
        header: { runtime: 'codex', model: 'codex:test' },
        items: [],
        hasMore: false,
        seq: 1,
      }),
      'chat.send': () => ({ queued: false }),
      'chat.resumeCheck': () => ({ status: 'ok', reason: '', recentlyModified: false }),
      'chat.commands': () => [],
      'files.suggest': () => [],
    });
  });
  env.app.tabs.openTab(SID);
  render(ChatView, {
    props: { ref: { machineId: LOCAL, sessionId: SID } },
    context: env.context,
  });
  await waitFor(() => expect(env.app.chats.get(SID)?.loaded).toBe(true));
  return env;
};

it('shows Codex working immediately after takeover, without waiting for a refreshed summary', async () => {
  const env = await open(true);
  env.server.handlers['chat.send'] = () => {
    env.server.push('chat.status', { sessionId: SID, seq: 2, status: 'working' });
    return { queued: false };
  };
  await fill(screen.getByRole('textbox', { name: /message/i }), 'Continue here');
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('status', { name: 'Waiting for Codex' });
  expect(env.app.chats.get(SID)?.ownedLive).toBe(true);
  expect(env.app.chats.get(SID)?.summary?.external).toBeNull();
  await fill(screen.getByRole('textbox', { name: /message/i }), 'One more thing');
  await userEvent.keyboard('{Enter}');
  expect(env.server.calls('chat.resumeCheck')).toHaveLength(1);
});

it('shows pending delivery before any runtime output and clears it on failure, retaining the draft', async () => {
  const env = await open();
  env.server.silent.add('chat.send');
  await fill(screen.getByRole('textbox', { name: /message/i }), 'Please investigate');
  await userEvent.keyboard('{Enter}');
  await screen.findByText('Sending to Codex…');
  const call = env.server.calls('chat.send')[0]!;
  env.server.live!.deliver({
    id: call.id,
    error: { code: 'NOT_LIVE', message: 'Runtime closed' },
  });
  await screen.findByText('Runtime closed');
  expect(screen.queryByText('Sending to Codex…')).toBeNull();
  expect(screen.getByRole('textbox', { name: /message/i }).textContent).toContain(
    'Please investigate',
  );
});

it('shows the ownership check before a resumed send and clears it when blocked', async () => {
  const env = await open(true);
  let finish!: (value: unknown) => void;
  env.server.handlers['chat.resumeCheck'] = () => new Promise((resolve) => (finish = resolve));
  await fill(screen.getByRole('textbox', { name: /message/i }), 'Continue');
  await userEvent.keyboard('{Enter}');
  await screen.findByText('Connecting to Codex…');
  finish({ status: 'blocked', reason: 'Open elsewhere', canStop: false, recentlyModified: false });
  await screen.findByText('Open elsewhere');
  expect(screen.queryByText('Connecting to Codex…')).toBeNull();
  expect(env.server.calls('chat.send')).toHaveLength(0);
});
