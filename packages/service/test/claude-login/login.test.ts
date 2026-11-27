import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_LOGIN_ERRORS, type ClaudeAccount, type UsageAccount } from '@threadgarden/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeLogin,
  SIGN_IN_TIMEOUT_MS,
  envRefusal,
  removeTranscript,
  type ClaudeLoginDeps,
  type LoginChange,
} from '../../src/claude-login/login.js';
import type { LoginControls } from '../../src/sdk/adapter.js';
import { FakeSession } from '../../src/testing/fake-adapter.js';
import { ManualTimers, settle } from '../chat/live-helpers.js';

const STATE = 'S7aTeS7aTeS7aTeS7aTeS7aTeS7aTeS7aTeS7aTe123';
const LINK = `https://claude.com/cai/oauth/authorize?code=true&client_id=c1&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=${STATE}`;
const LOCAL_LINK = `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=${STATE}`;
const CODE = 'c0deC0deC0de-_c0de';
const NOT_ACCEPTED =
  "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

const fakeSession = (): FakeSession => {
  const s = new FakeSession({
    cwd: '/home/me',
    env: {},
    claudePath: '/bin/claude',
    canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
  });
  s.loginStart = { manualUrl: LINK, automaticUrl: LOCAL_LINK };
  return s;
};

const setup = (over: Partial<ClaudeLoginDeps> = {}) => {
  const timers = new ManualTimers();
  const helpers: FakeSession[] = [];
  /** Helpers to hand out before fresh ones (a test's own, set up beforehand). */
  const queued: FakeSession[] = [];
  const emitted: ClaudeAccount[] = [];
  const noted: UsageAccount[] = [];
  const reports: string[] = [];
  const restarted: LoginChange[] = [];
  const logouts: string[] = [];
  const forgot: string[] = [];
  let logoutFails: string | undefined;
  let stored: UsageAccount | null = { kind: 'login', email: 'old@example.com', plan: 'pro' };
  const login = new ClaudeLogin({
    account: () => stored,
    noteAccount: (a) => {
      noted.push(a);
      stored = a;
    },
    startHelper: async () => {
      const s = queued.shift() ?? fakeSession();
      helpers.push(s);
      return s;
    },
    restartChats: (after) => void restarted.push(after),
    forgetAccount: () => {
      forgot.push('forgot');
      stored = null;
    },
    logout: async () => {
      logouts.push('claude auth logout');
      if (logoutFails !== undefined) throw new Error(logoutFails);
    },
    emit: (s) => emitted.push(s),
    timers,
    onError: (err, context) =>
      reports.push(
        `${context}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      ),
    ...over,
  });
  return {
    login,
    timers,
    helpers,
    queueHelper: (s: FakeSession) => void queued.push(s),
    emitted,
    noted,
    reports,
    restarts: () => restarted.length,
    restarted,
    logouts,
    forgot,
    failLogout: (m: string) => (logoutFails = m),
    setStored: (a: UsageAccount | null) => (stored = a),
  };
};

const rejection = async (p: Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await p;
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected a rejection');
};

describe('ClaudeLogin', () => {
  it('a sign-in from a chat runs on a helper process too', async () => {
    const ctx = setup();
    expect(await ctx.login.start('chat-1')).toEqual({ url: LINK });
    expect(ctx.helpers).toHaveLength(1);
    expect(ctx.helpers[0]!.loginCalls).toEqual([{ op: 'start' }]);
    expect(ctx.helpers[0]!.sent).toEqual([]); // no prompt
    expect(ctx.login.state().signingIn).toBe(true);
    // Without a chat (or with one that isn't live) it is the same.
    expect(await ctx.login.start()).toEqual({ url: LINK });
    expect(ctx.helpers).toHaveLength(2);
    expect(ctx.helpers[0]!.closed).toBe(true); // replaced
  });

  it('a code before the link answers LOGIN_NOT_STARTED and leaves the sign-in going', async () => {
    const ctx = setup();
    let release: (v: unknown) => void = () => {};
    const slow = fakeSession();
    (slow as { login: LoginControls }).login = {
      ...slow.login,
      start: () => new Promise((r) => (release = r)),
    };
    ctx.queueHelper(slow);
    const started = ctx.login.start('slow');
    await settle();
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.notStarted,
    });
    expect(ctx.login.state().signingIn).toBe(true);
    release({ manualUrl: LINK });
    expect(await started).toEqual({ url: LINK });
    expect(slow.loginCalls).toEqual([]); // the overridden start records nothing; no submit
    await ctx.login.submit(CODE);
    expect(slow.loginCalls.map((c) => c.op)).toEqual(['wait', 'submit']);
  });

  it('a second code while one is being checked gets that check’s answer and is not sent', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    let finish: (v: unknown) => void = () => {};
    const wait = helper.login.wait;
    (helper as { login: LoginControls }).login = {
      ...helper.login,
      wait: async () => {
        await new Promise((r) => (finish = r));
        return wait();
      },
    };
    const first = ctx.login.submit(CODE);
    await settle();
    const second = ctx.login.submit('another-code');
    finish(undefined);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(helper.loginCalls.filter((c) => c.op === 'submit')).toEqual([
      { op: 'submit', arg: { code: CODE, state: STATE } },
    ]);
    expect(ctx.restarts()).toBe(1);
  });

  it('a late success of a replaced sign-in restarts nothing and leaves the new one', async () => {
    const ctx = setup();
    await ctx.login.start();
    const old = ctx.helpers[0]!;
    let answer: (v: unknown) => void = () => {};
    old.accountInfo = () => new Promise((r) => (answer = r as never));
    const submitted = ctx.login.submit(CODE);
    await settle();
    await ctx.login.start(); // replaces it while its account is being read
    answer({ email: 'new@example.com', tokenSource: 'claude.ai' });
    expect(await rejection(submitted)).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.failed,
      message: 'A newer sign-in replaced this one.',
    });
    expect(ctx.restarts()).toBe(0);
    expect(ctx.login.state().signingIn).toBe(true);
    expect(ctx.helpers[1]!.closed).toBe(false);
  });

  it('signOut runs claude auth logout and clears the account', async () => {
    const ctx = setup();
    await ctx.login.signOut();
    expect(ctx.logouts).toHaveLength(1);
    expect(ctx.forgot).toHaveLength(1);
    expect(ctx.login.state()).toEqual({ account: null, expired: false, signingIn: false });
    expect(ctx.emitted.at(-1)).toEqual({ account: null, expired: false, signingIn: false });
  });

  it('signOut cancels an open sign-in', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    await ctx.login.signOut();
    expect(helper.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
    expect(ctx.logouts).toHaveLength(1);
  });

  it('signOut restarts the live chats, as a sign-out', async () => {
    const ctx = setup();
    await ctx.login.signOut();
    expect(ctx.restarted).toEqual(['signOut']);
  });

  it('an API-key machine refuses signOut', async () => {
    const ctx = setup({
      refusal: () => 'This machine uses an API key, so it has no Claude sign-in.',
    });
    expect(await rejection(ctx.login.signOut())).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
    });
    expect(ctx.logouts).toHaveLength(0);
    expect(ctx.forgot).toHaveLength(0);
    expect(ctx.restarts()).toBe(0);
  });

  it("a failing logout answers LOGIN_FAILED with Claude Code's words", async () => {
    const ctx = setup();
    ctx.failLogout('  Could not reach https://claude.ai/x?state=abc: no network  ');
    expect(await rejection(ctx.login.signOut())).toEqual(
      expect.objectContaining({
        code: CLAUDE_LOGIN_ERRORS.failed,
        message: 'Could not reach (link) no network',
      }),
    );
    expect(ctx.restarts()).toBe(0);
  });

  it('an API key setting refuses sign-in', async () => {
    const ctx = setup({
      refusal: () => 'This machine uses an API key, so it has no Claude sign-in.',
    });
    expect(await rejection(ctx.login.start())).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
      message: 'This machine uses an API key, so it has no Claude sign-in.',
    });
    expect(ctx.helpers).toHaveLength(0);
    expect(ctx.emitted).toEqual([]);
  });

  it('a second start cancels the first', async () => {
    const ctx = setup();
    await ctx.login.start();
    const first = ctx.helpers[0]!;
    await ctx.login.start();
    expect(first.closed).toBe(true);
    expect(ctx.helpers).toHaveLength(2);
    expect(ctx.helpers[1]!.closed).toBe(false);
    expect(ctx.login.state().signingIn).toBe(true);
  });

  it('a start replaced while it waits for its link answers LOGIN_FAILED and leaves the new one', async () => {
    const ctx = setup();
    let release: (v: unknown) => void = () => {};
    const slow = fakeSession();
    (slow as { login: LoginControls }).login = {
      ...slow.login,
      start: () => new Promise((r) => (release = r)),
    };
    ctx.queueHelper(slow);
    const firstStart = ctx.login.start('slow');
    await settle();
    await ctx.login.start('other');
    release({ manualUrl: LINK });
    const err = await rejection(firstStart);
    expect(err.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.message).not.toContain(STATE);
    expect(ctx.login.state().signingIn).toBe(true);
    expect(slow.closed).toBe(true);
    expect(ctx.helpers[1]!.closed).toBe(false);
  });

  it('a pasted code with spaces and a newline signs in', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    expect(await ctx.login.submit(`  ${CODE}\n`)).toEqual({
      account: { kind: 'login', email: 'old@example.com', plan: 'pro' },
    });
    expect(helper.loginCalls.slice(1)).toEqual([
      { op: 'wait' },
      { op: 'submit', arg: { code: CODE, state: STATE } },
    ]);
    expect(helper.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
  });

  it('a pasted code#state submits both parts', async () => {
    const ctx = setup();
    await ctx.login.start();
    await ctx.login.submit(`${CODE}#${STATE}\r\n`);
    expect(ctx.helpers[0]!.loginCalls.at(-1)).toEqual({
      op: 'submit',
      arg: { code: CODE, state: STATE },
    });
  });

  it('a code from another sign-in fails without saying either state, and ends the sign-in', async () => {
    const ctx = setup();
    await ctx.login.start();
    const err = await rejection(ctx.login.submit(`${CODE}#0therState0therState`));
    expect(err.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.message).not.toContain('0therState');
    expect(err.message).not.toContain(STATE);
    expect(err.message).not.toContain(CODE);
    expect(ctx.helpers[0]!.loginCalls.map((c) => c.op)).toEqual(['start']);
    expect(ctx.helpers[0]!.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
  });

  it('a wrong code ends the sign-in and a new start works', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    helper.loginError = new Error(NOT_ACCEPTED);
    const err = await rejection(ctx.login.submit('wrong'));
    expect(err).toMatchObject({ code: CLAUDE_LOGIN_ERRORS.failed, message: NOT_ACCEPTED });
    expect(helper.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
    expect(ctx.emitted.at(-1)?.signingIn).toBe(false);
    expect(ctx.restarts()).toBe(0);

    // Nothing is open any more.
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.notStarted,
    });
    // A new sign-in starts fresh, on a new helper.
    expect(await ctx.login.start()).toEqual({ url: LINK });
    expect(ctx.helpers).toHaveLength(2);
    expect(ctx.login.state().signingIn).toBe(true);
  });

  it('a code without a sign-in answers LOGIN_NOT_STARTED', async () => {
    const ctx = setup();
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.notStarted,
    });
  });

  it('cancel closes the helper process, and is a no-op with nothing open', async () => {
    const ctx = setup();
    await ctx.login.cancel();
    expect(ctx.emitted).toEqual([]);
    await ctx.login.start();
    await ctx.login.cancel();
    expect(ctx.helpers[0]!.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
    expect(ctx.emitted.map((s) => s.signingIn)).toEqual([true, false]);
    await ctx.login.cancel();
    expect(ctx.emitted).toHaveLength(2);
  });

  it('cancel while a code is being checked fails that check', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    (helper as { login: LoginControls }).login = {
      ...helper.login,
      wait: () => new Promise(() => {}),
    };
    const pending = ctx.login.submit(CODE);
    await settle();
    await ctx.login.cancel();
    expect(await rejection(pending)).toMatchObject({ code: CLAUDE_LOGIN_ERRORS.failed });
    expect(helper.closed).toBe(true);
    expect(ctx.restarts()).toBe(0);
  });

  it('the helper closes after 10 minutes', async () => {
    const ctx = setup();
    await ctx.login.start();
    ctx.timers.advance(SIGN_IN_TIMEOUT_MS - 1);
    expect(ctx.helpers[0]!.closed).toBe(false);
    ctx.timers.advance(1);
    expect(ctx.helpers[0]!.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
    expect(ctx.emitted.at(-1)?.signingIn).toBe(false);
    // The next code is told why, once.
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.failed,
      message: 'The sign-in timed out. Sign in again to get a new link.',
    });
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.notStarted,
    });
  });

  it('a helper that exits ends the sign-in', async () => {
    const ctx = setup();
    await ctx.login.start();
    ctx.helpers[0]!.end();
    await settle();
    expect(ctx.login.state().signingIn).toBe(false);
    expect(await rejection(ctx.login.submit(CODE))).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.failed,
    });
  });

  it('success emits the new account, clears expired, and restarts', async () => {
    const ctx = setup();
    ctx.login.noteLogin(false);
    expect(ctx.login.state().expired).toBe(true);
    await ctx.login.start();
    ctx.helpers[0]!.accountAfterLogin = {
      email: 'new@example.com',
      subscriptionType: 'max',
      tokenSource: 'claude.ai',
    };
    const done = await ctx.login.submit(CODE);
    const fresh = { kind: 'login', email: 'new@example.com', plan: 'max' };
    expect(done).toEqual({ account: fresh });
    expect(ctx.noted).toEqual([fresh]);
    expect(ctx.emitted.at(-1)).toEqual({ account: fresh, expired: false, signingIn: false });
    expect(ctx.restarted).toEqual(['signIn']);
    expect(ctx.helpers[0]!.closed).toBe(true);
  });

  it('success keeps the stored account when the process cannot tell the new one', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    // Before a process sees the login it reports no account at all (spike: tokenSource none).
    helper.accountAfterLogin = { tokenSource: 'none', apiProvider: 'firstParty' };
    expect(await ctx.login.submit(CODE)).toEqual({
      account: { kind: 'login', email: 'old@example.com', plan: 'pro' },
    });
    expect(ctx.noted).toEqual([]);

    await ctx.login.start();
    const second = ctx.helpers[1]!;
    second.accountInfo = () => Promise.reject(new Error('process gone'));
    expect(await ctx.login.submit(CODE)).toEqual({
      account: { kind: 'login', email: 'old@example.com', plan: 'pro' },
    });
    expect(ctx.restarts()).toBe(2);
  });

  it('noteLogin(false) marks expired; noteLogin(true) clears it', () => {
    const ctx = setup();
    expect(ctx.login.state()).toEqual({
      account: { kind: 'login', email: 'old@example.com', plan: 'pro' },
      expired: false,
      signingIn: false,
    });
    ctx.login.noteLogin(false);
    expect(ctx.login.state().expired).toBe(true);
    expect(ctx.emitted.at(-1)?.expired).toBe(true);
    ctx.login.noteLogin(false);
    expect(ctx.emitted).toHaveLength(1); // nothing changed, nothing sent
    ctx.login.noteLogin(true);
    expect(ctx.login.state().expired).toBe(false);
    expect(ctx.emitted.at(-1)?.expired).toBe(false);
  });

  it('publish sends the account only when it changed', () => {
    const ctx = setup();
    ctx.login.publish();
    expect(ctx.emitted).toHaveLength(1);
    ctx.login.publish();
    expect(ctx.emitted).toHaveLength(1);
    ctx.setStored({ kind: 'login', email: 'b@example.com' });
    ctx.login.publish();
    expect(ctx.emitted.at(-1)?.account).toEqual({ kind: 'login', email: 'b@example.com' });
  });

  it('never logs the code or the link, even when the SDK error quotes them', async () => {
    const ctx = setup();
    await ctx.login.start();
    const helper = ctx.helpers[0]!;
    helper.loginError = new Error(
      `Callback failed for ${CODE} (state ${STATE}) at ${LINK} and ${LOCAL_LINK}`,
    );
    const err = await rejection(ctx.login.submit(`${CODE}#${STATE}`));
    expect(err.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    for (const secret of [CODE, STATE, LINK, LOCAL_LINK, 'claude.com/cai']) {
      expect(err.message).not.toContain(secret);
      expect(ctx.reports.join('\n')).not.toContain(secret);
      expect(JSON.stringify(ctx.emitted)).not.toContain(secret);
    }
    expect(err.message).toContain('Callback failed');

    // A start that fails quoting its link.
    const other = setup();
    const s = fakeSession();
    s.loginError = new Error(`Could not open ${LINK}`);
    other.queueHelper(s);
    const failed = await rejection(other.login.start('c'));
    expect(failed.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(failed.message).not.toContain(STATE);
    expect(failed.message).not.toContain('claude.com/cai');
    expect(other.reports.join('\n')).not.toContain(STATE);
  });

  it('an API-key machine refuses start', async () => {
    const ctx = setup();
    ctx.setStored({ kind: 'apiKey' });
    expect(await rejection(ctx.login.start())).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
    });
    ctx.setStored({ kind: 'provider', provider: 'bedrock' });
    expect(await rejection(ctx.login.start())).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
    });
    expect(ctx.helpers).toHaveLength(0);
    expect(ctx.login.state().signingIn).toBe(false);
  });

  it('a Codex chat refuses start', async () => {
    const ctx = setup();
    expect(
      await rejection(ctx.login.start('codex-00000000-0000-0000-0000-000000000000')),
    ).toMatchObject({ code: CLAUDE_LOGIN_ERRORS.unsupported });
    expect(ctx.helpers).toHaveLength(0);
  });

  it('a link without a manual address fails and closes the helper', async () => {
    const ctx = setup({
      startHelper: async () => {
        const s = fakeSession();
        s.loginStart = { automaticUrl: LOCAL_LINK };
        ctx.helpers.push(s);
        return s;
      },
    });
    const err = await rejection(ctx.login.start());
    expect(err.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.message).not.toContain('localhost');
    expect(ctx.helpers[0]!.closed).toBe(true);
    expect(ctx.login.state().signingIn).toBe(false);
  });

  it('a helper that cannot start answers LOGIN_FAILED', async () => {
    const ctx = setup({
      startHelper: async () => {
        throw new Error('Claude Code is not available');
      },
    });
    expect(await rejection(ctx.login.start())).toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.failed,
      message: 'Claude Code is not available',
    });
    expect(ctx.login.state().signingIn).toBe(false);
  });

  it('dispose ends an open sign-in', async () => {
    const ctx = setup();
    await ctx.login.start();
    ctx.login.dispose();
    expect(ctx.helpers[0]!.closed).toBe(true);
    expect(ctx.timers.pending).toBe(0);
  });
});

describe('envRefusal', () => {
  it('refuses an API key or a cloud provider in the environment, and nothing else', () => {
    expect(envRefusal({ PATH: '/usr/bin' })).toBeUndefined();
    expect(envRefusal({ ANTHROPIC_API_KEY: '' })).toBeUndefined();
    expect(envRefusal({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toMatch(/API key/);
    expect(envRefusal({ anthropic_api_key: 'sk-ant-x' })).toMatch(/API key/);
    expect(envRefusal({ CLAUDE_CODE_USE_BEDROCK: '1' })).toMatch(/cloud provider/);
    expect(envRefusal({ CLAUDE_CODE_USE_VERTEX: 'true' })).toMatch(/cloud provider/);
    expect(envRefusal({ CLAUDE_CODE_USE_BEDROCK: '0' })).toBeUndefined();
    expect(envRefusal({ CLAUDE_CODE_USE_VERTEX: 'false' })).toBeUndefined();
    // Never the key itself.
    expect(envRefusal({ ANTHROPIC_API_KEY: 'sk-ant-x' })).not.toContain('sk-ant');
  });
});

describe('removeTranscript', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("deletes the helper's transcript in any project folder and leaves the rest", async () => {
    dir = await mkdtemp(join(tmpdir(), 'tg-login-'));
    const projects = join(dir, 'projects');
    await mkdir(join(projects, 'C--Users-me'), { recursive: true });
    await mkdir(join(projects, 'other'), { recursive: true });
    await writeFile(join(projects, 'C--Users-me', 'helper-id.jsonl'), '{}\n');
    await mkdir(join(projects, 'C--Users-me', 'helper-id', 'subagents'), { recursive: true });
    await writeFile(join(projects, 'other', 'keep.jsonl'), '{}\n');
    await removeTranscript(projects, 'helper-id');
    expect(await readdir(join(projects, 'C--Users-me'))).toEqual([]);
    expect(await readdir(join(projects, 'other'))).toEqual(['keep.jsonl']);
  });

  it('is quiet when there is no projects folder', async () => {
    await expect(removeTranscript(join(tmpdir(), 'tg-none-xyz'), 'id')).resolves.toBeUndefined();
  });
});
