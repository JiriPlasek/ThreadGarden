import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import PhoneShell from '../../src/lib/components/phone/PhoneShell.svelte';
import { PhoneNavState, type PhoneLevel } from '../../src/lib/state/phone-nav.svelte';
import { M1, project, setupTwoMachines, summary } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('the phone navigation', () => {
  it('goes down one entry per level, and back up one level at a time', () => {
    const pushed: PhoneLevel[] = [];
    const nav = new PhoneNavState();
    let backs = 0;
    nav.bind({ push: (l) => void pushed.push(l), back: (n) => void (backs += n) });
    // A chat opened from the places (search, a notification) still has its list above it.
    nav.go('chat');
    expect(pushed).toEqual(['list', 'chat']);
    expect(nav.level).toBe('chat');
    nav.up();
    expect(backs).toBe(1);
    // The history moved: the level follows it.
    nav.shown('list');
    nav.go('places');
    expect(backs).toBe(2);
    nav.shown(undefined);
    expect(nav.level).toBe('places');
    nav.up();
    expect(backs).toBe(2);
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
