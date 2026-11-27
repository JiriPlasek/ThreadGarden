import { CLAUDE_LOGIN_CAPABILITY, CLAUDE_LOGIN_ERRORS } from '@threadgarden/protocol';
import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '../../src/lib/service/client';
import { ClaudeAccounts } from '../../src/lib/state/claude-accounts.svelte';
import { LOCAL, M1, setupTwoMachines } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';

const MAX = { kind: 'login', email: 'you@example.com', plan: 'max' } as const;
const PRO = { kind: 'login', email: 'other@example.com', plan: 'pro' } as const;
const LINK = 'https://claude.ai/oauth/authorize?code=true&state=abc';

const start = () =>
  setupTwoMachines({
    m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
    configure: (s) => {
      s.handlers['claude.account'] = () => ({ account: MAX, expired: false, signingIn: false });
    },
    configureRemote: (s) => {
      s.handlers['claude.account'] = () => ({ account: MAX, expired: true, signingIn: false });
      s.handlers['claude.signIn'] = () => ({ url: LINK });
      s.handlers['claude.signInCode'] = (p) => {
        if ((p as { code: string }).code !== 'GOOD') {
          throw new RpcFail(CLAUDE_LOGIN_ERRORS.failed, 'Invalid code');
        }
        return { account: PRO };
      };
      s.handlers['claude.signInCancel'] = () => ({});
    },
  });

describe('ClaudeAccounts', () => {
  it("reads each machine's account by its id", async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    expect(accounts.get(LOCAL)).toBeUndefined();
    await accounts.refresh(LOCAL);
    await accounts.refresh(M1);
    expect(accounts.get(LOCAL)).toEqual({ account: MAX, expired: false, signingIn: false });
    expect(accounts.get(M1)?.expired).toBe(true);
  });

  it("follows the machine's claude.account events once asked", async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    await accounts.refresh(M1);
    env.remote.push('claude.account', { account: PRO, expired: false, signingIn: false });
    await vi.waitFor(() => expect(accounts.get(M1)?.account?.email).toBe('other@example.com'));
    expect(accounts.get(M1)?.expired).toBe(false);
    // Another machine's event is not this one's.
    expect(accounts.get(LOCAL)).toBeUndefined();
  });

  it("signIn answers the link and runs on the chat's process when given one", async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    expect(await accounts.signIn(M1, 's1')).toBe(LINK);
    expect(await accounts.signIn(M1)).toBe(LINK);
    expect(env.remote.calls('claude.signIn').map((c) => c.params)).toEqual([
      { sessionId: 's1' },
      {},
    ]);
  });

  it('submit sends the code and answers the account', async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    expect(await accounts.submit(M1, 'GOOD')).toEqual(PRO);
    expect(env.remote.calls('claude.signInCode').map((c) => c.params)).toEqual([{ code: 'GOOD' }]);
    // The row reads the account again.
    await vi.waitFor(() => expect(env.remote.calls('claude.account').length).toBeGreaterThan(0));
  });

  it("a refused code rejects with Claude Code's words", async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    const err = await accounts.submit(M1, 'WRONG').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect((err as RequestError).message).toBe('Invalid code');
  });

  it('cancel ends the sign-in on that machine', async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    await accounts.cancel(M1);
    expect(env.remote.calls('claude.signInCancel')).toHaveLength(1);
    expect(env.server.calls('claude.signInCancel')).toHaveLength(0);
  });

  it('an unknown machine rejects', async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    await expect(accounts.refresh('nope')).rejects.toThrow();
  });
});
