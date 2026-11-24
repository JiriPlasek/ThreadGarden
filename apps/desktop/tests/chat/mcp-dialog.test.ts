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
  add: vi.fn<
    (name: string, scope: string, config: unknown) => Promise<{ restartPending: boolean }>
  >(async () => ({ restartPending: false })),
  remove: vi.fn<(name: string, scope: string) => Promise<{ restartPending: boolean }>>(
    async () => ({ restartPending: false }),
  ),
  ...over,
});

const show = (mcp: ReturnType<typeof fakeMcp>, over: Record<string, unknown> = {}) =>
  render(McpServersDialog, {
    open: true,
    mcp: mcp as unknown as ChatMcp,
    live: true,
    canConfigure: true,
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
    expect(mcp.submitCallback).toHaveBeenCalledWith(
      'api',
      'http://localhost:1234/cb?code=x',
      expect.any(Function),
    );
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

  it('the line stays through Connecting…, and a fall back to Needs sign-in says so', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })]);
    const { rerender } = show(mcp, { remote: false });
    const LINE = 'Finish signing in in your browser, then:';
    const NOTE = 'Not signed in yet — finish in your browser, then try again.';
    const as = async (status: McpServer['status']) => {
      mcp.state.servers = [server({ name: 'api', status, canSignIn: true })];
      await rerender({ mcp: { ...mcp, state: { ...mcp.state } } as unknown as ChatMcp });
    };
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText(LINE);
    expect(screen.queryByText(NOTE)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: "I've signed in" }));
    await as('pending');
    expect(screen.getByText(LINE)).toBeTruthy();
    await as('needs-auth');
    expect(await screen.findByText(LINE)).toBeTruthy();
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it('a reconnect error from "I\'ve signed in" shows under the row; the button is off while busy', async () => {
    let fail!: (e: Error) => void;
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })], {
      act: vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          }),
      ),
    });
    show(mcp, { remote: false });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.click(await screen.findByRole('button', { name: "I've signed in" }));
    const button = () => screen.getByRole('button', { name: "I've signed in" }) as HTMLButtonElement;
    await waitFor(() => expect(button().disabled).toBe(true));
    fail(new Error('Server "api" is not responding'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Server "api" is not responding'),
    );
    expect(button().disabled).toBe(false);
  });

  it('remote: the paste field clears once the address is accepted, even if the reconnect fails', async () => {
    const mcp = fakeMcp([server({ name: 'api', status: 'needs-auth', canSignIn: true })], {
      submitCallback: vi.fn(async (_n: string, _u: string, onSaved?: () => void) => {
        onSaved?.();
        throw new Error('Server "api" is not responding');
      }),
    });
    show(mcp, { remote: true });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText(/Paste the address/), 'http://l/cb?code=x');
    await userEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Server "api" is not responding'),
    );
    expect(screen.queryByLabelText(/Paste the address/)).toBeNull();
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

  it('Add server opens the form and an add returns to the list', async () => {
    const mcp = fakeMcp([server({ name: 'files' })]);
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: '+ Add server' }));
    expect(screen.getByText('Add MCP server')).toBeTruthy();
    expect(screen.queryAllByTestId('mcp-row')).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Name'), 'sentry');
    await userEvent.type(screen.getByLabelText('URL'), 'https://mcp.example/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getAllByTestId('mcp-row')).toHaveLength(1));
    expect(mcp.add).toHaveBeenCalledWith('sentry', 'local', {
      type: 'http',
      url: 'https://mcp.example/mcp',
    });
    expect(screen.queryByText('Add MCP server')).toBeNull();
    expect(screen.queryByText(/^Added\./)).toBeNull();
  });

  it('+ Add server sits in the body, not in the title row', () => {
    show(fakeMcp([server()]));
    const add = screen.getByRole('button', { name: '+ Add server' });
    const title = screen.getByText('MCP servers (this chat)');
    expect(title.parentElement?.contains(add)).toBe(false);
    expect(title.contains(add)).toBe(false);
  });

  it("no Add server without mcp-config or when the chat isn't running", () => {
    const { unmount } = show(fakeMcp([server()]), { canConfigure: false });
    expect(screen.queryByRole('button', { name: '+ Add server' })).toBeNull();
    unmount();
    show(fakeMcp([server()]), { live: false });
    expect(screen.queryByRole('button', { name: '+ Add server' })).toBeNull();
  });

  it('restartPending says when the server appears', async () => {
    const mcp = fakeMcp([server()], {
      add: vi.fn(async () => ({ restartPending: true })),
    });
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: '+ Add server' }));
    await userEvent.type(screen.getByLabelText('Name'), 'sentry');
    await userEvent.type(screen.getByLabelText('URL'), 'https://mcp.example/mcp');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText('Added. It appears when this chat restarts between turns.'),
    ).toBeTruthy();
    expect(screen.getAllByTestId('mcp-row')).toHaveLength(1);
  });

  it('Remove is in the menu for local, user and project servers only', async () => {
    const mcp = fakeMcp([
      server({ name: 'p', source: 'project' }),
      server({ name: 'u', source: 'user' }),
      server({ name: 'l', source: 'local' }),
      server({ name: 'c', source: 'claudeai', claudeAi: true }),
      server({ name: 'x', source: 'plugin:foo' }),
    ]);
    show(mcp);
    for (const name of ['p', 'u', 'l']) {
      await userEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
      expect(await screen.findByText('Remove')).toBeTruthy();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('Remove')).toBeNull());
    }
    for (const name of ['c', 'x']) {
      await userEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
      await screen.findByText('Reconnect');
      expect(screen.queryByText('Remove')).toBeNull();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('Reconnect')).toBeNull());
    }
  });

  it('Remove asks first, naming the server and the scope, then removes from that scope', async () => {
    const mcp = fakeMcp([server({ name: 'a', source: 'user' })]);
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'More for a' }));
    await userEvent.click(await screen.findByText('Remove'));
    expect(await screen.findByText('Remove a?')).toBeTruthy();
    expect(
      screen.getByText('Claude Code on Ubuntu PC stops using it for Me, every project.'),
    ).toBeTruthy();
    expect(mcp.remove).not.toHaveBeenCalled();
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Remove',
    });
    await userEvent.click(confirm);
    await waitFor(() => expect(mcp.remove).toHaveBeenCalledWith('a', 'user'));
    expect(screen.queryByText(/^Removed\./)).toBeNull();
  });

  it('a removal that needs a restart says so', async () => {
    const mcp = fakeMcp([server({ name: 'a', source: 'user' })], {
      remove: vi.fn(async () => ({ restartPending: true })),
    });
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'More for a' }));
    await userEvent.click(await screen.findByText('Remove'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(
      await screen.findByText('Removed. It disappears when this chat restarts between turns.'),
    ).toBeTruthy();
  });

  it('confirming Remove keeps the MCP servers dialog open', async () => {
    const mcp = fakeMcp([server({ name: 'a', source: 'user' })]);
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'More for a' }));
    await userEvent.click(await screen.findByText('Remove'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(mcp.remove).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByText('MCP servers (this chat)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add server' })).toBeTruthy();
  });

  it("a refused remove shows Claude Code's words", async () => {
    const mcp = fakeMcp([server({ name: 'a', source: 'user' })], {
      remove: vi.fn(async () => {
        throw new Error('No MCP server named "a" in user scope');
      }),
    });
    show(mcp);
    await userEvent.click(screen.getByRole('button', { name: 'More for a' }));
    await userEvent.click(await screen.findByText('Remove'));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }),
    );
    expect((await within(screen.getByRole('alertdialog')).findByRole('alert')).textContent).toBe(
      'No MCP server named "a" in user scope',
    );
  });
});
