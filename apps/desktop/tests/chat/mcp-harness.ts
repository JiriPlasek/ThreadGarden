import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { MCP_CAPABILITY, PROTOCOL_VERSION, type McpState } from '@threadgarden/protocol';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import { LOCAL, machineInfo, setup, summary } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

export type Options = {
  sessionId?: string;
  live?: boolean;
  capabilities?: string[];
  waiting?: string[];
  commands?: { name: string; description: string; argumentHint: string }[];
  resumeCheck?: Record<string, unknown>;
  configure?: (server: FakeServer) => void;
};

export const mcpState = (sessionId: string, waiting: string[], live = true): McpState => ({
  sessionId,
  live,
  waiting,
  servers: [
    ...waiting.map((name) => ({
      name,
      source: 'project',
      status: 'unapproved' as const,
      claudeAi: false,
      canSignIn: false,
    })),
    { name: 'sign', source: 'user', status: 'needs-auth', claudeAi: false, canSignIn: true },
    { name: 'broken', source: 'user', status: 'failed', claudeAi: false, canSignIn: false },
  ],
});

/** Renders one chat on This PC, whose service advertises `mcp` unless told otherwise. */
export const renderChat = async (o: Options = {}) => {
  const sessionId = o.sessionId ?? 's1';
  const live = o.live ?? true;
  const env = await setup((server) => {
    Object.assign(server.handlers, {
      hello: () => ({
        serviceVersion: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        machine: machineInfo(LOCAL, 'my-host', o.capabilities ?? ['remote', MCP_CAPABILITY]),
      }),
      'chat.open': () => ({
        summary: summary(sessionId, {
          status: live ? 'idle' : 'history',
          live,
          cwd: '/work/alpha',
        }),
        header: {},
        items: [],
        hasMore: false,
        seq: 1,
      }),
      'chat.send': () => ({ queued: false }),
      'chat.resumeCheck': () =>
        o.resumeCheck ?? { status: 'ok', reason: '', recentlyModified: false },
      'chat.commands': () => o.commands ?? [],
      'chat.models': () => [],
      'chat.wake': () => ({}),
      'files.suggest': () => [],
      'mcp.list': () => mcpState(sessionId, o.waiting ?? [], live),
      'mcp.approve': () => ({}),
    });
    o.configure?.(server);
  });
  env.app.tabs.openTab(sessionId);
  render(ChatView, {
    props: { ref: { machineId: LOCAL, sessionId } },
    context: env.context,
  });
  await waitFor(() => expect(env.app.chats.get(sessionId)?.loaded).toBe(true));
  return env;
};

/**
 * Opens the chat header's "Chat state" menu. jsdom has no layout, so the
 * trigger is given a client rect: bits-ui keeps a menu hidden while its
 * anchor has none.
 */
export const openStateMenu = async (): Promise<void> => {
  const trigger = await screen.findByRole('button', { name: 'Chat state' });
  trigger.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
  await userEvent.click(trigger);
  await screen.findAllByRole('menuitem');
};
