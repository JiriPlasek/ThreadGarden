import type { ChatTask } from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ChatView from '../../src/lib/components/chat/ChatView.svelte';
import { LOCAL, setup, summary } from '../layout/harness';
import { text, tool, user } from './fixtures';

const mount = async () => {
  const task: ChatTask = {
    taskId: 'agent',
    toolUseId: 'tu-agent',
    kind: 'agent',
    taskType: 'local_agent',
    description: 'Explore the parser',
    status: 'running',
    startedAt: Date.now(),
  };
  const env = await setup((server) => {
    server.handlers['chat.open'] = () => ({
      summary: summary('s', { live: true, status: 'idle' }),
      header: {},
      items: [
        user('u1', 'Find the bug'),
        tool('agent', 'Agent', { description: 'Explore the parser' }),
        text('a1', 'Found it'),
      ],
      tasks: [task],
      hasMore: false,
      seq: 1,
    });
    server.handlers['chat.timeline'] = () => ({ blocks: [] });
  });
  await env.app.chats.open('s');
  env.app.chats.byId.get('s')!.view.turnScroll = new Map([['full-turn', 40]]);
  env.app.chats.byId.get('s')!.conciseView.turnScroll = new Map([['concise-turn', 80]]);
  const rendered = render(ChatView, {
    context: env.context,
    props: { ref: { machineId: LOCAL, sessionId: 's' } },
  });
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...env, ...rendered };
};

describe('Concise view integration', () => {
  it('keeps the composer and draft mounted across all views with separate list memories', async () => {
    const { app } = await mount();
    const composer = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.type(composer, 'Keep this draft');
    const switcher = screen.getByRole('group', { name: 'Chat view' });
    expect(
      within(switcher)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(['Conversation', 'Concise', 'Timeline']);
    await userEvent.click(within(switcher).getByRole('button', { name: 'Concise' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(composer);
    expect(composer.textContent).toBe('Keep this draft');
    const chat = app.chats.byId.get('s')!;
    expect(chat.conciseView).not.toBe(chat.view);
    await userEvent.click(within(switcher).getByRole('button', { name: 'Timeline' }));
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(composer.isConnected).toBe(true);
    await userEvent.click(within(switcher).getByRole('button', { name: 'Concise' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(composer);
    expect(composer.textContent).toBe('Keep this draft');
    expect(chat.conciseView.turnScroll).toEqual(new Map([['concise-turn', 80]]));
    expect(chat.view.turnScroll).toEqual(new Map([['full-turn', 40]]));
  });

  it('allows Concise on a copied chat without loading Timeline', async () => {
    const { app, server } = await mount();
    app.chats.byId.get('s')!.copiedAt = Date.now() - 1000;
    await userEvent.click(screen.getByRole('button', { name: 'Concise' }));
    await screen.findByText('Found it');
    expect(app.settings.chatView).toBe('concise');
    expect(server.calls('chat.timeline')).toHaveLength(0);
  });

  it('opens the full conversation before Activity navigates to a hidden tool', async () => {
    const { app, container } = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Concise' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Show Explore the parser in the chat' }),
    );
    await waitFor(() => expect(app.settings.chatView).toBe('conversation'));
    await waitFor(() => expect(container.querySelector('[data-item-id="agent"]')).toBeTruthy());
  });
});
