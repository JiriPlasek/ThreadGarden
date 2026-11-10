import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ConfirmDialog from '../../src/lib/components/ConfirmDialog.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import { renderChat } from '../interaction/helpers';
import { M1, setupTwoMachines, summary } from '../layout/harness';

const renameInput = () =>
  screen.findByRole('textbox', { name: 'Chat title' }) as Promise<HTMLInputElement>;

describe('F2 renames chats', () => {
  it('renames the list cursor instead of the current chat, without opening it', async () => {
    const { app, server, context } = await renderChat({
      configure: (s) => {
        s.handlers['sessions.list'] = () => ({ items: [summary('a'), summary('b')] });
        s.handlers['meta.update'] = () => ({});
      },
    });
    render(ChatList, { context });
    await screen.findByRole('option', { name: /Chat b/ });
    screen.getByRole('listbox').focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{F2}');
    const input = await renameInput();
    expect(input.value).toBe('Chat b');
    expect(screen.getAllByRole('dialog', { name: 'Rename chat' })).toHaveLength(1);
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed from list{Enter}');
    await waitFor(() =>
      expect(server.calls('meta.update').at(-1)?.params).toEqual({
        sessionId: 'b',
        customTitle: 'Renamed from list',
      }),
    );
    expect(app.tabs.open).toHaveLength(1);
    expect(app.tabs.active).toContain('/s1');
  });

  it('renames the current chat from the composer and preserves its draft', async () => {
    const { server, composer } = await renderChat({
      configure: (s) => {
        s.handlers['meta.update'] = () => ({});
      },
    });
    await userEvent.type(composer(), 'draft in progress');
    await userEvent.keyboard('{F2}');
    const input = await renameInput();
    expect(input.value).toBe('Chat s1');
    await userEvent.clear(input);
    await userEvent.type(input, 'New title{Enter}');
    await waitFor(() =>
      expect(server.calls('meta.update').at(-1)?.params).toEqual({
        sessionId: 's1',
        customTitle: 'New title',
      }),
    );
    expect(composer().value).toBe('draft in progress');
    expect(server.calls('chat.send')).toHaveLength(0);
    expect(server.calls('chat.end')).toHaveLength(0);
  });

  it('uses the existing reset-title behavior when the title is blank', async () => {
    const { server } = await renderChat({
      configure: (s) => {
        s.handlers['meta.update'] = () => ({});
      },
    });
    await fireEvent.keyDown(window, { key: 'F2' });
    await userEvent.clear(await renameInput());
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(server.calls('meta.update').at(-1)?.params).toEqual({
        sessionId: 's1',
        customTitle: null,
      }),
    );
  });

  it('ignores modifiers, repeats and composition, and does not open over a dialog or menu', async () => {
    const { context } = await renderChat();
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
    ]) {
      await fireEvent.keyDown(window, { key: 'F2', ...extra });
      expect(screen.queryByRole('dialog', { name: 'Rename chat' })).toBeNull();
    }
    const trigger = screen.getByRole('button', { name: 'Chat state' });
    trigger.getClientRects = () => [new DOMRect(0, 0, 24, 24)] as unknown as DOMRectList;
    await userEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const rename = within(menu).getByRole('menuitem', { name: /Rename/ });
    expect(rename.querySelector('[data-shortcut-hint]')?.textContent).toBe('F2');
    await fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.queryByRole('dialog', { name: 'Rename chat' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    render(ConfirmDialog, {
      props: { open: true, title: 'Confirm something', onConfirm: () => {} },
      context,
    });
    await screen.findByRole('alertdialog');
    await fireEvent.keyDown(window, { key: 'F2' });
    expect(screen.queryByRole('dialog', { name: 'Rename chat' })).toBeNull();
  });

  it('an empty list does not fall through to the current chat', async () => {
    const { context } = await renderChat();
    render(ChatList, { context });
    screen.getByRole('listbox').focus();
    await userEvent.keyboard('{F2}');
    expect(screen.queryByRole('dialog', { name: 'Rename chat' })).toBeNull();
  });

  it('renames a remote list chat through its own machine', async () => {
    const { app, context, server, remote } = await setupTwoMachines({
      configureRemote: (s) => {
        s.handlers['sessions.list'] = () => ({ items: [summary('remote-chat')] });
        s.handlers['meta.update'] = () => ({});
      },
    });
    app.places.select({ kind: 'project', projectId: 'p1', machineId: M1 });
    render(ChatList, { context });
    await screen.findByRole('option', { name: /Chat remote-chat/ });
    screen.getByRole('listbox').focus();
    await userEvent.keyboard('{ArrowDown}{F2}');
    await userEvent.clear(await renameInput());
    await userEvent.keyboard('Remote title{Enter}');
    await waitFor(() =>
      expect(remote.calls('meta.update').at(-1)?.params).toEqual({
        sessionId: 'remote-chat',
        customTitle: 'Remote title',
      }),
    );
    expect(server.calls('meta.update')).toHaveLength(0);
  });
});
