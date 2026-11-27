import { CLAUDE_LOGIN_CAPABILITY, CLAUDE_LOGIN_ERRORS } from '@threadgarden/protocol';
import { describe, expect, it } from 'vitest';
import { RequestError } from '../../src/lib/service/client';
import { ClaudeAccounts } from '../../src/lib/state/claude-accounts.svelte';
import { M1, setupTwoMachines } from '../layout/harness';
import { RpcFail } from '../service/fake-ws';

const PRO = { kind: 'login', email: 'other@example.com', plan: 'pro' } as const;
const LINK = 'https://claude.ai/oauth/authorize?code=true&state=abc';

const start = () =>
  setupTwoMachines({
    m1Capabilities: ['remote', CLAUDE_LOGIN_CAPABILITY],
    configureRemote: (s) => {
      s.handlers['claude.signOut'] = () => ({});
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

  it('signOut signs that machine out', async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    await accounts.signOut(M1);
    expect(env.remote.calls('claude.signOut').map((c) => c.params)).toEqual([{}]);
    expect(env.server.calls('claude.signOut')).toHaveLength(0);
  });

  it("a refused sign-out rejects with the machine's words", async () => {
    const env = await start();
    env.remote.handlers['claude.signOut'] = () => {
      throw new RpcFail(CLAUDE_LOGIN_ERRORS.failed, 'Not logged in');
    };
    const accounts = new ClaudeAccounts(env.app.machines);
    await expect(accounts.signOut(M1)).rejects.toThrow('Not logged in');
  });

  it('an unknown machine rejects', async () => {
    const env = await start();
    const accounts = new ClaudeAccounts(env.app.machines);
    await expect(accounts.signOut('nope')).rejects.toThrow();
  });
});
