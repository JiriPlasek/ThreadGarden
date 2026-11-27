/**
 * Router handlers for signing in to Claude on this machine (protocol 14),
 * behind the `claude-login` capability. `ClaudeLogin` does the work; every
 * failure leaves here as a `ServiceError` (which the router never logs) with
 * text that carries no code, link or state. Not local-only: the phone signs in too.
 */
import { CLAUDE_LOGIN_ERRORS } from '@threadgarden/protocol';
import type { ClaudeLogin } from '../../claude-login/login.js';
import { ServiceError, type Router } from '../router.js';

/** Anything unexpected becomes a plain `LOGIN_FAILED`: its text could quote a secret. */
const contained = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    throw new ServiceError(CLAUDE_LOGIN_ERRORS.failed, 'The sign-in failed.');
  }
};

export const registerClaudeLoginHandlers = (router: Router, deps: { login: ClaudeLogin }): void => {
  const { login } = deps;
  router.register('claude.account', async () => login.state());
  router.register('claude.signIn', (p) => contained(() => login.start(p.sessionId)));
  router.register('claude.signInCode', (p) => contained(() => login.submit(p.code)));
  router.register('claude.signInCancel', async () => {
    await contained(() => login.cancel());
    return {};
  });
};
