import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  CLAUDE_LOGIN_CAPABILITY,
  PROTOCOL_VERSION,
  type ClaudeAccount,
} from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import ClaudeAccountsSettings from '../../src/lib/components/ClaudeAccountsSettings.svelte';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import { LOCAL, machineInfo, setupTwoMachines } from '../layout/harness';
import type { FakeServer } from '../service/fake-ws';

const LINK = 'https://claude.ai/oauth/authorize?code=true&state=x';

const signedIn = (account: ClaudeAccount['account'], expired = false): ClaudeAccount => ({
  account,
  expired,
  signingIn: false,
});

const serveLogin = (s: FakeServer, state: ClaudeAccount): void => {
  s.handlers['claude.account'] = () => state;
  s.handlers['claude.signIn'] = () => ({ url: LINK });
  s.handlers['claude.signInCancel'] = () => ({});
};

/** This PC and Ubuntu PC, each saying `local` / `remote`; `older`: Ubuntu PC lacks claude-login. */
const start = async (local: ClaudeAccount, remote: ClaudeAccount, o: { older?: boolean } = {}) => {
  const env = await setupTwoMachines({
    m1Capabilities: o.older ? ['remote'] : ['remote', CLAUDE_LOGIN_CAPABILITY],
    configure: (s) => {
      s.handlers['hello'] = () => ({
        serviceVersion: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        machine: machineInfo(LOCAL, 'my-host', ['remote', CLAUDE_LOGIN_CAPABILITY]),
      });
      serveLogin(s, local);
    },
    configureRemote: (s) => serveLogin(s, remote),
  });
  render(ClaudeAccountsSettings, { context: env.context });
  const section = within(screen.getByRole('region', { name: 'Claude accounts' }));
  return {
    ...env,
    section,
    row: (name: string) =>
      within(section.getByRole('group', { name: `Claude account on ${name}` })),
  };
};

const MAX = { kind: 'login', email: 'you@example.com', plan: 'max' } as const;

describe('Settings → Claude accounts', () => {
  it('sits after Machines in Settings', async () => {
    const env = await setupTwoMachines();
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /^settings$/i });
    const machines = within(dialog).getByRole('region', { name: 'Machines' });
    const accounts = within(dialog).getByRole('region', { name: 'Claude accounts' });
    expect(machines.compareDocumentPosition(accounts) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('shows the email and plan with Switch account, and an expired sign-in with Sign in', async () => {
    const { row } = await start(signedIn(MAX), signedIn(MAX, true));
    const here = row('This PC');
    expect(await here.findByText('you@example.com · Max')).toBeTruthy();
    expect(here.getByRole('button', { name: 'Switch account' })).toBeTruthy();
    const ubuntu = row('Ubuntu PC');
    expect(await ubuntu.findByText('Sign-in expired')).toBeTruthy();
    expect(ubuntu.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('an email alone when there is no plan; Not known yet still offers Sign in', async () => {
    const { row } = await start(
      signedIn({ kind: 'login', email: 'other@example.com' }),
      signedIn(null),
    );
    expect(await row('This PC').findByText('other@example.com')).toBeTruthy();
    const ubuntu = row('Ubuntu PC');
    expect(await ubuntu.findByText('Not known yet')).toBeTruthy();
    expect(ubuntu.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('an API key or a provider has no sign-in', async () => {
    const { row } = await start(
      signedIn({ kind: 'apiKey' }),
      signedIn({ kind: 'provider', provider: 'bedrock' }),
    );
    const here = row('This PC');
    expect(await here.findByText('Uses an API key')).toBeTruthy();
    expect(here.queryByRole('button')).toBeNull();
    const ubuntu = row('Ubuntu PC');
    expect(await ubuntu.findByText('Uses bedrock')).toBeTruthy();
    expect(ubuntu.queryByRole('button')).toBeNull();
  });

  it('an older machine says to update it, without buttons', async () => {
    const { row, remote } = await start(signedIn(MAX), signedIn(MAX), { older: true });
    const ubuntu = row('Ubuntu PC');
    expect(ubuntu.getByText('Update this machine to sign in from here.')).toBeTruthy();
    expect(ubuntu.queryByRole('button')).toBeNull();
    expect(remote.calls('claude.account')).toHaveLength(0);
  });

  it("Sign in opens the dialog for that row's machine", async () => {
    const { row, remote, server } = await start(signedIn(MAX), signedIn(MAX, true));
    await userEvent.click(await row('Ubuntu PC').findByRole('button', { name: 'Sign in' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to Claude (Ubuntu PC)' });
    expect(await within(dialog).findByText(LINK)).toBeTruthy();
    expect(remote.calls('claude.signIn').map((c) => c.params)).toEqual([{}]);
    expect(server.calls('claude.signIn')).toHaveLength(0);
  });

  it('Switch account on This PC signs in there', async () => {
    const { row, server } = await start(signedIn(MAX), signedIn(MAX));
    await userEvent.click(await row('This PC').findByRole('button', { name: 'Switch account' }));
    expect(await screen.findByRole('dialog', { name: 'Sign in to Claude (This PC)' })).toBeTruthy();
    expect(server.calls('claude.signIn')).toHaveLength(1);
  });

  it('a row follows the machine as it changes', async () => {
    const { row, remote } = await start(signedIn(MAX), signedIn(MAX));
    const ubuntu = row('Ubuntu PC');
    expect(await ubuntu.findByText('you@example.com · Max')).toBeTruthy();
    remote.push('claude.account', signedIn(MAX, true));
    expect(await ubuntu.findByText('Sign-in expired')).toBeTruthy();
  });
});
