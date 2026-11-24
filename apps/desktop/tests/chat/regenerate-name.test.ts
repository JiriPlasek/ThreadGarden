import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ChatHeader from '../../src/lib/components/chat/ChatHeader.svelte';
import { SCOPE_CONTEXT } from '../../src/lib/state/context';
import { M1, setupTwoMachines, setup, summary } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';

const openMenu = async () => {
  const trigger = screen.getByRole('button', { name: 'Chat state' });
  trigger.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
  await userEvent.click(trigger);
};
const menu = async () => {
  await openMenu();
  return screen.findByRole('menuitem', { name: 'Regenerate name' });
};

describe('regenerate chat name', () => {
  it('renames an old history chat through summary events', async () => {
    let title = 'Old name';
    const { app, server, context } = await setup((s) => {
      s.handlers['sessions.summaries'] = () => ({ items: [summary('a', { title })] });
      s.handlers['chat.regenerateTitle'] = () => {
        title = 'Useful new name';
        s.push('sessions.changed', { sessionIds: ['a'] });
        return { title, changed: true };
      };
    });
    await app.chats.open('a');
    render(ChatHeader, { context, props: { chat: app.chats.get('a')! } });
    await userEvent.click(await menu());
    await waitFor(() => expect(app.chats.get('a')?.summary?.title).toBe('Useful new name'));
    expect(server.calls('chat.regenerateTitle')[0]?.params).toEqual({ sessionId: 'a' });
  });

  it('keeps the old name on failure and presents the existing error UI', async () => {
    const { app, context } = await setup((s) => {
      s.handlers['chat.regenerateTitle'] = () => {
        throw new RpcFail('INTERNAL', 'Naming failed');
      };
    });
    await app.chats.open('a');
    const old = app.chats.get('a')!.summary!.title;
    render(ChatHeader, { context, props: { chat: app.chats.get('a')! } });
    await userEvent.click(await menu());
    expect((await screen.findByRole('alert')).textContent).toContain('Naming failed');
    expect(app.chats.get('a')!.summary!.title).toBe(old);
  });

  it('hides regeneration in a read-only view', async () => {
    const { app, context } = await setup();
    await app.chats.open('a');
    render(ChatHeader, { context, props: { chat: app.chats.get('a')!, readOnly: true } });
    await fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat state' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    await screen.findByRole('menuitem', { name: /Rename/ });
    expect(screen.queryByRole('menuitem', { name: 'Regenerate name' })).toBeNull();
  });
  it('disables the pending action and prevents a duplicate request', async () => {
    const { app, server, context } = await setup((s) => s.silent.add('chat.regenerateTitle'));
    await app.chats.open('a');
    render(ChatHeader, { context, props: { chat: app.chats.get('a')! } });
    await userEvent.click(await menu());
    await openMenu();
    const pending = await screen.findByRole('menuitem', { name: /Regenerating name/ });
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(pending.getAttribute('aria-busy')).toBe('true');
    await fireEvent.click(pending);
    expect(server.calls('chat.regenerateTitle')).toHaveLength(1);
  });

  it('sends the action to the remote chat scope', async () => {
    const { app, server, remote, context } = await setupTwoMachines({
      configureRemote: (s) => {
        s.handlers['chat.regenerateTitle'] = () => ({ title: 'Chat a', changed: false });
      },
    });
    const scope = app.scopes.get(M1)!;
    await scope.chats.open('a');
    context.set(SCOPE_CONTEXT, scope);
    render(ChatHeader, { context, props: { chat: scope.chats.get('a')! } });
    await userEvent.click(await menu());
    await waitFor(() => expect(remote.calls('chat.regenerateTitle')).toHaveLength(1));
    expect(server.calls('chat.regenerateTitle')).toHaveLength(0);
  });
});
