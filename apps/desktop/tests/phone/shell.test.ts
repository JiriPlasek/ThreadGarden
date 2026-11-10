import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import PhoneShell from '../../src/lib/components/phone/PhoneShell.svelte';
import { PhoneNavState } from '../../src/lib/state/phone-nav.svelte';
import { M1, project, setupTwoMachines, summary } from '../layout/harness';
import type { ChatRef } from '../../src/lib/state/refs';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('the phone navigation', () => {
  it('goes down one entry per level, and back up one level at a time', () => {
    const ops: string[] = [];
    const nav = new PhoneNavState();
    nav.bind({
      push: (l, o) => void ops.push(`push ${l}${o?.dialog ? ' dialog' : ''}`),
      replace: (l) => void ops.push(`replace ${l}`),
      back: (n) => void ops.push(`back ${n}`),
    });
    // A chat opened from the places (search, an alert) still has its list above it.
    nav.go('chat');
    expect(ops).toEqual(['push list', 'push chat']);
    expect(nav.level).toBe('chat');
    nav.up();
    expect(ops.at(-1)).toBe('back 1');
    // The history moved: the level follows it.
    nav.popped('list');
    expect(nav.level).toBe('list');
    nav.go('places');
    expect(ops.at(-1)).toBe('back 1');
    nav.popped(undefined);
    expect(nav.level).toBe('places');
    nav.up();
    expect(ops.at(-1)).toBe('back 1');
    expect(ops).toHaveLength(4);
  });

  it('Back with a dialog open closes the dialog and keeps the level', () => {
    const ops: string[] = [];
    const nav = new PhoneNavState();
    let closed = 0;
    nav.onCloseDialogs(() => closed++);
    nav.bind({
      push: (l, o) => void ops.push(`push ${l}${o?.dialog ? ' dialog' : ''}`),
      replace: (l) => void ops.push(`replace ${l}`),
      back: (n) => void ops.push(`back ${n}`),
    });
    nav.go('list');
    nav.dialogOpened();
    expect(ops.at(-1)).toBe('push list dialog');
    // Back: the history leaves the dialog's entry.
    nav.popped('list');
    expect(closed).toBe(1);
    expect(nav.level).toBe('list');
    // It closes: its entry is already gone.
    nav.dialogClosed();
    expect(ops).toEqual(['push list', 'push list dialog']);

    // Closed by itself (its X): its entry goes.
    nav.dialogOpened();
    nav.dialogClosed();
    expect(ops.slice(-2)).toEqual(['push list dialog', 'back 1']);

    // New chat starting a chat: the dialog's entry becomes the chat's.
    nav.dialogOpened();
    nav.go('chat');
    expect(ops.slice(-2)).toEqual(['push list dialog', 'replace chat']);
    nav.dialogClosed();
    expect(ops.at(-1)).toBe('replace chat');
    expect(nav.level).toBe('chat');
  });

  it('without a page history, Back shows the level above at once', () => {
    const nav = new PhoneNavState();
    nav.go('chat');
    nav.up();
    expect(nav.level).toBe('list');
    nav.up();
    expect(nav.level).toBe('places');
  });
});

const start = () =>
  setupTwoMachines({
    configureRemote: (s) => {
      s.handlers['projects.list'] = () => [project('p1', 'tg-cli')];
      s.handlers['sessions.list'] = () => ({ items: [summary('r1', { title: 'Fix the parser' })] });
    },
  });

describe('the phone shell', () => {
  it('shows one column at a time: places, then chats, then a chat, and back', async () => {
    const env = await start();
    const nav = new PhoneNavState();
    render(PhoneShell, { context: env.context, props: { nav } });
    const places = await screen.findByRole('navigation', { name: 'Places' });
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull();
    expect(document.documentElement.hasAttribute('data-phone')).toBe(true);

    const group = within(places).getByRole('group', { name: 'Ubuntu PC' });
    await userEvent.click(await within(group).findByRole('button', { name: /tg-cli/ }));
    const list = await screen.findByRole('region', { name: 'Chat list' });
    expect(screen.queryByRole('navigation', { name: 'Places' })).toBeNull();

    await userEvent.click(await within(list).findByRole('option', { name: /Fix the parser/ }));
    await waitFor(() => expect(nav.level).toBe('chat'));
    expect(env.app.tabs.active).toBe(`${M1}/r1`);
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Back to chats' }));
    expect(await screen.findByRole('region', { name: 'Chat list' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Back to places' }));
    expect(await screen.findByRole('navigation', { name: 'Places' })).toBeTruthy();
  });

  it('a chat opened elsewhere (New chat, Recent chats) is shown; closing the last returns to the list', async () => {
    const env = await start();
    await env.app.tabs.restore();
    const nav = new PhoneNavState();
    render(PhoneShell, { context: env.context, props: { nav } });
    await screen.findByRole('navigation', { name: 'Places' });
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
    await waitFor(() => expect(nav.level).toBe('chat'));
    env.app.tabs.close({ machineId: M1, sessionId: 'r1' });
    await waitFor(() => expect(nav.level).toBe('list'));
  });

  it('an opened alert shows its chat, also when it is the active tab already', async () => {
    const env = await start();
    await env.app.tabs.restore();
    env.app.tabs.openTab({ machineId: M1, sessionId: 'r1' });
    const nav = new PhoneNavState();
    let open: ((chat: ChatRef) => void) | undefined;
    const onOpenChat = async (cb: (chat: ChatRef) => void) => {
      open = cb;
      return () => {};
    };
    render(PhoneShell, { context: env.context, props: { nav, onOpenChat } });
    await screen.findByRole('navigation', { name: 'Places' });
    await waitFor(() => expect(open).toBeDefined());
    open!({ machineId: M1, sessionId: 'r1' });
    await waitFor(() => expect(nav.level).toBe('chat'));
    expect(env.app.tabs.active).toBe(`${M1}/r1`);
    // Its title is in the phone's bar.
    expect(await screen.findByText('Chat r1', { selector: 'header span' })).toBeTruthy();
  });

  it('AppShell picks the phone shell: no tabs bar, no agents strip, no resizable columns', async () => {
    const env = await start();
    render(AppShell, { context: env.context });
    await screen.findByRole('navigation', { name: 'Places' });
    expect(document.querySelector('[data-phone-shell]')).not.toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('separator', { name: /resize/i })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull();
  });
});
