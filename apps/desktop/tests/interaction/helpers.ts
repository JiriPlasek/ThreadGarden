import type { ChatItem, ChatStatus, ChatSummary } from '@threadgarden/protocol';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { expect } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import { setup, summary } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

export const SID = 's1';
export const CWD = '/work/alpha';

type Req = Extract<ChatItem, { kind: 'permissionRequest' }>;

export const request = (over: Partial<Req> & Pick<Req, 'toolName' | 'input'>): Req => ({
  kind: 'permissionRequest',
  id: `perm:${over.requestId ?? 'r1'}`,
  requestId: 'r1',
  suggestions: [],
  state: 'pending',
  variant: 'tool',
  ...over,
});

export const bashRequest = (over: Partial<Req> = {}): Req =>
  request({
    toolName: 'Bash',
    input: { command: 'ls -la', description: 'List files in the project' },
    title: 'Claude wants to run ls -la',
    suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
    ...over,
  });

export type ChatOptions = {
  status?: ChatStatus;
  items?: ChatItem[];
  summary?: Partial<ChatSummary>;
  configure?: (server: FakeServer) => void;
};

/** Renders the chat `s1` in a wired app against a fake service with interaction handlers. */
export const renderChat = async (o: ChatOptions = {}) => {
  const status = o.status ?? 'idle';
  const live = ['needsYou', 'working', 'idle'].includes(status);
  const env = await setup((server) => {
    Object.assign(server.handlers, {
      'chat.open': () => ({
        summary: summary(SID, { status, live, cwd: CWD, ...o.summary }),
        header: {},
        items: o.items ?? [],
        hasMore: false,
        seq: 1,
      }),
      'chat.respond': () => ({}),
      'chat.send': () => ({ queued: status === 'working' }),
      'chat.interrupt': () => ({}),
      'chat.resumeCheck': () => ({ status: 'ok', reason: '', recentlyModified: false }),
      'chat.resumeCommand': () => ({ command: `claude --resume ${SID}` }),
      'chat.commands': () => [],
      'files.suggest': () => [],
    });
    o.configure?.(server);
  });
  env.app.tabs.openTab(SID);
  const view = render(ChatView, { props: { sessionId: SID }, context: env.context });
  await waitFor(() => expect(env.app.chats.get(SID)?.loaded).toBe(true));
  const composer = (): HTMLTextAreaElement =>
    screen.getByRole('textbox', { name: /message/i }) as HTMLTextAreaElement;
  return { ...env, view, composer };
};

/** Pushes a live `chat.items` event for `s1`. */
export const pushItems = (server: FakeServer, seq: number, items: ChatItem[]): void =>
  server.push('chat.items', { sessionId: SID, seq, items });

export const pushStatus = (server: FakeServer, seq: number, status: ChatStatus): void =>
  server.push('chat.status', { sessionId: SID, seq, status });

/**
 * Puts `text` in a text field in one input event, the caret at its end, and
 * leaves the field focused. Typing key by key (`userEvent.type`) re-renders
 * the chat on every key; under a loaded parallel test run that made tests
 * with long chats time out now and then.
 */
export const fill = async (field: HTMLTextAreaElement, text: string): Promise<void> => {
  field.focus();
  field.value = text;
  field.setSelectionRange(text.length, text.length);
  await fireEvent.input(field);
};
