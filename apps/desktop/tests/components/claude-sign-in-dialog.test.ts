import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { CLAUDE_LOGIN_CAPABILITY, CLAUDE_LOGIN_ERRORS } from '@threadgarden/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ClaudeSignInDialog from '../../src/lib/components/ClaudeSignInDialog.svelte';
import ChatPane from '../../src/lib/components/layout/ChatPane.svelte';
import { M1, setupTwoMachines, summary } from '../layout/harness';
import { RpcFail, type FakeServer } from '../service/fake-ws';

const { openExternal, copyText } = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<boolean>>(async () => true),
  copyText: vi.fn<(s: string) => Promise<void>>(async () => {}),
}));
vi.mock('../../src/lib/native', async (original) => ({
  ...(await original<typeof import('../../src/lib/native')>()),
  openExternal,
  copyText,
}));

const LINK = 'https://claude.ai/oauth/authorize?code=true&state=first';
const LINK2 = 'https://claude.ai/oauth/authorize?code=true&state=second';
const PRO = { kind: 'login', email: 'other@example.com', plan: 'pro' } as const;

/** Ubuntu PC's fake sign-in: each `claude.signIn` hands out the next link; `GOOD` signs in. */
const signInHandlers = (s: FakeServer): void => {
  const links = [LINK, LINK2];
  s.handlers['claude.account'] = () => ({ account: null, expired: false, signingIn: false });
  s.handlers['claude.signIn'] = () => ({ url: links.shift() ?? LINK2 });
  s.handlers['claude.signInCode'] = (p) => {
    if ((p as { code: string }).code !== 'GOOD') {
      throw new RpcFail(CLAUDE_LOGIN_ERRORS.failed, 'Invalid code');
    }
    return { account: PRO };
  };
  s.handlers['claude.signInCancel'] = () => ({});
};

const start = async () => {
  const env = await setupTwoMachines({
    m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
    configureRemote: signInHandlers,
  });
  render(ClaudeSignInDialog, {
    props: { machineId: M1, machineName: 'Ubuntu PC', open: true },
    context: env.context,
  });
  const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude (Ubuntu PC)' });
  await within(dialog).findByText(LINK);
  return { ...env, dialog: within(dialog) };
};

const signInButton = (d: ReturnType<typeof within>) =>
  d.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;

beforeEach(() => {
  openExternal.mockClear();
  copyText.mockClear();
});

describe('Sign in to Claude', () => {
  it('shows the link with Copy and Open', async () => {
    const { dialog, remote } = await start();
    expect(dialog.getByText('Open this link and approve:')).toBeTruthy();
    await userEvent.click(dialog.getByRole('button', { name: 'Copy' }));
    expect(copyText).toHaveBeenCalledWith(LINK);
    await userEvent.click(dialog.getByRole('button', { name: 'Open' }));
    expect(openExternal).toHaveBeenCalledWith(LINK);
    expect(remote.calls('claude.signIn').map((c) => c.params)).toEqual([{}]);
  });

  it('Sign in is disabled until a code is typed', async () => {
    const { dialog } = await start();
    expect(signInButton(dialog).disabled).toBe(true);
    await userEvent.type(dialog.getByLabelText('Paste the code claude.ai shows you'), '   ');
    expect(signInButton(dialog).disabled).toBe(true);
    await userEvent.type(dialog.getByLabelText('Paste the code claude.ai shows you'), 'GOOD');
    expect(signInButton(dialog).disabled).toBe(false);
  });

  it("a wrong code shows Claude Code's words, stays open, and Start again fetches a fresh link", async () => {
    const { dialog, remote } = await start();
    await userEvent.type(dialog.getByLabelText('Paste the code claude.ai shows you'), 'WRONG');
    await userEvent.click(signInButton(dialog));
    expect((await dialog.findByRole('alert')).textContent).toBe('Invalid code');
    expect(screen.getByRole('dialog', { name: 'Sign in to Claude (Ubuntu PC)' })).toBeTruthy();
    // The sign-in that refused the code is over: no sending to it again.
    expect(dialog.queryByRole('button', { name: 'Sign in' })).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: 'Start again' }));
    expect(await dialog.findByText(LINK2)).toBeTruthy();
    expect(dialog.queryByRole('alert')).toBeNull();
    expect(remote.calls('claude.signIn')).toHaveLength(2);
    expect(
      (dialog.getByLabelText('Paste the code claude.ai shows you') as HTMLInputElement).value,
    ).toBe('');
  });

  it('success shows Signed in as ‹email›. and closes', async () => {
    const { dialog, remote } = await start();
    await userEvent.type(dialog.getByLabelText('Paste the code claude.ai shows you'), ' GOOD ');
    await userEvent.click(signInButton(dialog));
    expect(await dialog.findByText('Signed in as other@example.com.')).toBeTruthy();
    expect(remote.calls('claude.signInCode').map((c) => c.params)).toEqual([{ code: 'GOOD' }]);
    await waitFor(
      () => expect(screen.queryByRole('dialog', { name: /Sign in to Claude/ })).toBeNull(),
      { timeout: 4000 },
    );
    // A finished sign-in is not cancelled.
    expect(remote.calls('claude.signInCancel')).toHaveLength(0);
  });

  it('Cancel cancels the sign-in and closes', async () => {
    const { dialog, remote } = await start();
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(remote.calls('claude.signInCancel')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Sign in to Claude/ })).toBeNull(),
    );
  });

  it('Back on the phone cancels the sign-in', async () => {
    const { remote } = await start();
    // What the phone shell does on Back: Escape to the top open dialog.
    const OPEN = '[role="dialog"][data-state="open"]';
    const top = [...document.querySelectorAll<HTMLElement>(OPEN)].at(-1)!;
    top.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await waitFor(() => expect(remote.calls('claude.signInCancel')).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Sign in to Claude/ })).toBeNull(),
    );
  });

  /** The dialog for a machine whose `claude.signIn` fails with `code`. */
  const failingStart = async (code: string, message: string) => {
    const env = await setupTwoMachines({
      m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
      configureRemote: (s) => {
        signInHandlers(s);
        s.handlers['claude.signIn'] = () => {
          throw new RpcFail(code, message);
        };
      },
    });
    render(ClaudeSignInDialog, {
      props: { machineId: M1, machineName: 'Ubuntu PC', open: true },
      context: env.context,
    });
    return within(await screen.findByRole('dialog', { name: /Sign in to Claude/ }));
  };

  it("a link that can't be had says why and offers Start again", async () => {
    const dialog = await failingStart(CLAUDE_LOGIN_ERRORS.failed, 'Claude Code stopped.');
    expect((await dialog.findByRole('alert')).textContent).toBe('Claude Code stopped.');
    expect(dialog.getByRole('button', { name: 'Start again' })).toBeTruthy();
  });

  it('a machine with no Claude sign-in says why and offers no Start again', async () => {
    const dialog = await failingStart(
      CLAUDE_LOGIN_ERRORS.unsupported,
      'This machine uses an API key, so it has no Claude sign-in.',
    );
    expect((await dialog.findByRole('alert')).textContent).toBe(
      'This machine uses an API key, so it has no Claude sign-in.',
    );
    expect(dialog.queryByRole('button', { name: 'Start again' })).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(dialog.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('the sign-in line in a chat', () => {
  it("the sign-in line's button opens the dialog for that chat's machine", async () => {
    const env = await setupTwoMachines({
      m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
      configureRemote: (s) => {
        signInHandlers(s);
        Object.assign(s.handlers, {
          'chat.open': (p: unknown) => ({
            summary: summary((p as { sessionId: string }).sessionId, {
              status: 'idle',
              live: true,
            }),
            header: {},
            items: [
              {
                kind: 'system',
                id: 'login-1',
                level: 'error',
                text: "Claude Code isn't signed in on ubuntu-pc, or its sign-in expired.",
                signIn: true,
              },
            ],
            hasMore: false,
            seq: 1,
          }),
          'chat.resumeCheck': () => ({ status: 'ok', reason: '', recentlyModified: false }),
          'chat.commands': () => [],
          'chat.models': () => [],
          'files.suggest': () => [],
        });
      },
    });
    env.app.tabs.openTab({ machineId: M1, sessionId: 's1' });
    render(ChatPane, { context: env.context });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude (Ubuntu PC)' });
    expect(await within(dialog).findByText(LINK)).toBeTruthy();
    // The chat's own process signs in, on its machine.
    expect(env.remote.calls('claude.signIn').map((c) => c.params)).toEqual([{ sessionId: 's1' }]);
    expect(env.server.calls('claude.signIn')).toHaveLength(0);
  });

  it('a machine without claude-login shows the line without the button', async () => {
    const env = await setupTwoMachines({
      configureRemote: (s) => {
        Object.assign(s.handlers, {
          'chat.open': (p: unknown) => ({
            summary: summary((p as { sessionId: string }).sessionId),
            header: {},
            items: [
              { kind: 'system', id: 'l', level: 'error', text: 'Not signed in.', signIn: true },
            ],
            hasMore: false,
            seq: 1,
          }),
          'chat.commands': () => [],
          'chat.models': () => [],
        });
      },
    });
    env.app.tabs.openTab({ machineId: M1, sessionId: 's1' });
    render(ChatPane, { context: env.context });
    expect(await screen.findByText('Not signed in.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in to Claude' })).toBeNull();
  });
});
