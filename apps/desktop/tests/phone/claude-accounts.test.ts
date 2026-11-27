import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { CLAUDE_LOGIN_CAPABILITY } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import ClaudeAccountsSettings from '../../src/lib/components/ClaudeAccountsSettings.svelte';
import { setupTwoMachines } from '../layout/harness';

vi.mock('../../src/lib/native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/native')>()),
  isPhone: true,
}));

describe('Claude accounts on the phone', () => {
  it("lists the paired machines (the phone's core runs no Claude) and signs in from there", async () => {
    const env = await setupTwoMachines({
      m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
      configureRemote: (s) => {
        s.handlers['claude.account'] = () => ({ account: null, expired: true, signingIn: false });
        s.handlers['claude.signIn'] = () => ({ url: 'https://claude.ai/oauth/authorize?x' });
        s.handlers['claude.signInCancel'] = () => ({});
      },
    });
    render(ClaudeAccountsSettings, { context: env.context });
    const section = within(screen.getByRole('region', { name: 'Claude accounts' }));
    expect(section.queryByRole('group', { name: 'Claude account on This PC' })).toBeNull();
    const ubuntu = within(section.getByRole('group', { name: 'Claude account on Ubuntu PC' }));
    await userEvent.click(await ubuntu.findByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByRole('dialog', { name: 'Sign in to Claude (Ubuntu PC)' }),
    ).toBeTruthy();
    expect(env.server.calls('claude.account')).toHaveLength(0);
  });
});
