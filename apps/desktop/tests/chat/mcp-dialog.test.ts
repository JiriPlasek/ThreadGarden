import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { McpServer } from '@threadgarden/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import McpServersDialog from '../../src/lib/components/chat/McpServersDialog.svelte';
import type { ChatMcp } from '../../src/lib/state/mcp.svelte';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<boolean>>(async () => true),
}));
vi.mock('../../src/lib/native', async (original) => ({
  ...(await original<typeof import('../../src/lib/native')>()),
  openExternal,
}));

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: 'github',
  source: 'project',
  status: 'connected',
  claudeAi: false,
  canSignIn: false,
  ...over,
});

const fakeMcp = (servers: McpServer[], over: Record<string, unknown> = {}) => ({
  state: { sessionId: 's1', live: true, servers, waiting: [] },
  load: vi.fn(async () => {}),
  startPolling: vi.fn(() => () => {}),
  approve: vi.fn<(name: string) => Promise<void>>(async () => {}),
  signIn: vi.fn<(name: string) => Promise<string | null>>(async () => 'https://auth.example/start'),
  submitCallback: vi.fn<(name: string, url: string) => Promise<void>>(async () => {}),
  act: vi.fn<(name: string, action: string) => Promise<void>>(async () => {}),
  ...over,
});

const show = (mcp: ReturnType<typeof fakeMcp>, over: Record<string, unknown> = {}) =>
  render(McpServersDialog, {
    open: true,
    mcp: mcp as unknown as ChatMcp,
    live: true,
    remote: false,
    machineName: 'Ubuntu PC',
    onWake: async () => {},
    ...over,
  });

beforeEach(() => {
  openExternal.mockClear();
  document.body.removeAttribute('style');
});

describe('McpServersDialog', () => {
  it('lists every server with source and status', () => {
    show(
      fakeMcp([
        server({ name: 'a', source: 'project', status: 'connected' }),
        server({ name: 'b', source: 'claudeai', status: 'needs-auth', claudeAi: true }),
        server({ name: 'c', source: 'user', status: 'failed', error: 'boom' }),
      ]),
    );
    expect(screen.getByText('MCP servers (this chat)')).toBeTruthy();
    const rows = screen.getAllByTestId('mcp-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('a')).toBeTruthy();
    expect(within(rows[0]!).getByText('project')).toBeTruthy();
    expect(within(rows[0]!).getByText('Connected')).toBeTruthy();
    expect(within(rows[1]!).getByText('claude.ai')).toBeTruthy();
    expect(within(rows[1]!).getByText('Needs sign-in')).toBeTruthy();
    expect(within(rows[2]!).getByText('Failed: boom')).toBeTruthy();
  });

  it("Approve calls approve with the server's name", async () => {
    const mcp = fakeMcp([server({ name: 'files', status: 'unapproved' })]);
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mcp.approve).toHaveBeenCalledWith('files');
  });

  it('Sign in opens the link; on a remote machine the paste field appears and sends what was pasted', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    show(mcp, { remote: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(mcp.signIn).toHaveBeenCalledWith('api');
    expect(openExternal).toHaveBeenCalledWith('https://auth.example/start');
    const field = await screen.findByLabelText("Paste the address from your browser's address bar");
    await userEvent.type(field, 'http://localhost:1234/cb?code=x');
    await userEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    expect(mcp.submitCallback).toHaveBeenCalledWith('api', 'http://localhost:1234/cb?code=x');
  });

  it('the paste field goes away once the server is no longer waiting for sign-in', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    const { rerender } = show(mcp, { remote: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText(/Paste the address/);
    mcp.state.servers = [server({ name: 'api', status: 'connected' })];
    await rerender({ mcp: { ...mcp, state: { ...mcp.state } } as unknown as ChatMcp });
    await waitFor(() => expect(screen.queryByLabelText(/Paste the address/)).toBeNull());
  });

  it('on This PC no paste field', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    show(mcp, { remote: false });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(openExternal).toHaveBeenCalledWith('https://auth.example/start');
    expect(screen.queryByLabelText(/Paste the address/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish sign-in' })).toBeNull();
  });

  it('on This PC, after Sign in the "I\'ve signed in" line appears, reconnects, and goes when connected', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    const { rerender } = show(mcp, { remote: false });
    expect(screen.queryByText('Finish signing in in your browser, then:')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Finish signing in in your browser, then:')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: "I've signed in" }));
    expect(mcp.act).toHaveBeenCalledWith('api', 'reconnect');
    mcp.state.servers = [server({ name: 'api', status: 'connected' })];
    await rerender({ mcp: { ...mcp, state: { ...mcp.state } } as unknown as ChatMcp });
    await waitFor(() =>
      expect(screen.queryByText('Finish signing in in your browser, then:')).toBeNull(),
    );
  });

  it("a remote machine has the paste field and no \"I've signed in\"", async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    show(mcp, { remote: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText(/Paste the address/);
    expect(screen.queryByText('Finish signing in in your browser, then:')).toBeNull();
    expect(screen.queryByRole('button', { name: "I've signed in" })).toBeNull();
  });

  it("claude.ai Sign in opens claude.ai's connector settings", async () => {
    const mcp = fakeMcp([
      server({ name: 'Gmail', source: 'claudeai', status: 'needs-auth', claudeAi: true }),
    ]);
    show(mcp, { remote: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(openExternal).toHaveBeenCalledWith('https://claude.ai/settings/connectors');
    expect(mcp.signIn).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Paste the address/)).toBeNull();
  });

  it('not live shows Wake the chat and calls onWake', async () => {
    const onWake = vi.fn(async () => {});
    show(fakeMcp([]), { live: false, onWake });
    expect(
      screen.getByText("This chat isn't running. Wake it to see its MCP servers."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Wake the chat' }));
    expect(onWake).toHaveBeenCalled();
  });

  it("an action's error is shown as Claude Code words it", async () => {
    const mcp = fakeMcp([server({ name: 'files', status: 'failed' })], {
      act: vi.fn(async () => {
        throw new Error('Server "files" is not responding');
      }),
    });
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Server "files" is not responding'),
    );
  });

  it('the menu turns a server off in this project', async () => {
    const mcp = fakeMcp([server({ name: 'files', status: 'connected' })]);
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'More for files' }));
    await userEvent.click(await screen.findByText('Turn off in this project'));
    expect(mcp.act).toHaveBeenCalledWith('files', 'disable');
  });
});
