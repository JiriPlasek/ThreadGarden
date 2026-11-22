import { screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { openStateMenu, renderChat } from './mcp-harness';

const banner = (): HTMLElement | null => screen.queryByRole('status', { name: /MCP server not/ });

const openMenu = openStateMenu;

describe('the MCP banner', () => {
  it('shows the banner for a waiting project server', async () => {
    await renderChat({ waiting: ['files'] });
    const b = await screen.findByRole('status', { name: /MCP server not/ });
    expect(b.textContent).toContain(`MCP server "files" (from this project) isn't approved.`);
    expect(within(b).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'MCP servers…' })).toBeTruthy();
  });

  it('says "and 2 more" for three waiting servers', async () => {
    await renderChat({ waiting: ['a', 'b', 'c'] });
    const b = await screen.findByRole('status', { name: /MCP server not/ });
    expect(b.textContent).toContain(
      `MCP server "a" and 2 more (from this project) aren't approved.`,
    );
  });

  it('no banner for needs sign-in or failed servers', async () => {
    const env = await renderChat({ waiting: [] });
    await waitFor(() => expect(env.server.calls('mcp.list').length).toBeGreaterThan(0));
    await waitFor(() => expect(env.server.calls('mcp.list')).toHaveLength(1));
    expect(banner()).toBeNull();
  });

  it('no banner and no mcp request for a Codex chat', async () => {
    const env = await renderChat({ sessionId: 'codex-1', waiting: ['files'] });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /MCP servers/ })).toBeNull();
    expect(banner()).toBeNull();
    expect(env.server.calls('mcp.list')).toHaveLength(0);
  });

  it('no banner, no menu item, no request on a machine without mcp', async () => {
    const env = await renderChat({ capabilities: ['remote'], waiting: ['files'] });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /MCP servers/ })).toBeNull();
    expect(banner()).toBeNull();
    expect(env.server.calls('mcp.list')).toHaveLength(0);
  });

  it('no banner for a paused chat', async () => {
    const env = await renderChat({ live: false, waiting: ['files'] });
    await new Promise((r) => setTimeout(r, 50));
    expect(banner()).toBeNull();
    expect(env.server.calls('chat.wake')).toHaveLength(0);
  });

  it('Approve approves the named server only', async () => {
    const env = await renderChat({ waiting: ['a', 'b'] });
    const b = await screen.findByRole('status', { name: /MCP server not/ });
    await userEvent.click(within(b).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(env.server.calls('mcp.approve')).toHaveLength(1));
    expect(env.server.calls('mcp.approve')[0]!.params).toEqual({ sessionId: 's1', name: 'a' });
  });

  it('dismiss hides it for this session', async () => {
    await renderChat({ waiting: ['files'] });
    const b = await screen.findByRole('status', { name: /MCP server not/ });
    await userEvent.click(within(b).getByRole('button', { name: 'Dismiss' }));
    expect(banner()).toBeNull();
  });

  it('the header menu opens the dialog', async () => {
    await renderChat({ waiting: [] });
    await openMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: /MCP servers…/ }));
    expect(await screen.findByText('MCP servers (this chat)')).toBeTruthy();
  });
});

describe('Wake the chat', () => {
  const wakeFromDialog = async (): Promise<void> => {
    await openMenu();
    await userEvent.click(await screen.findByRole('menuitem', { name: /MCP servers…/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Wake the chat' }));
  };

  it('asks first when the check cannot verify', async () => {
    const env = await renderChat({
      live: false,
      resumeCheck: { status: 'unverified', reason: 'no lock', recentlyModified: false },
    });
    await wakeFromDialog();
    await screen.findByText('Continue this chat here?');
    expect(env.server.calls('chat.wake')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Continue here' }));
    await waitFor(() => expect(env.server.calls('chat.wake')).toHaveLength(1));
    expect(env.server.calls('chat.wake')[0]!.params).toEqual({ sessionId: 's1' });
  });

  it('shows the blocked banner when another process holds the chat', async () => {
    const env = await renderChat({
      live: false,
      resumeCheck: { status: 'blocked', reason: 'Open in a terminal', canStop: false },
    });
    await wakeFromDialog();
    await screen.findByText("This chat can't be continued here.");
    expect(env.server.calls('chat.wake')).toHaveLength(0);
  });

  it('wakes at once when the check is ok', async () => {
    const env = await renderChat({ live: false });
    await wakeFromDialog();
    await waitFor(() => expect(env.server.calls('chat.wake')).toHaveLength(1));
  });
});
