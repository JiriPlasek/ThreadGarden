import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_LOGIN_ERRORS, type ClaudeAccount, type UsageAccount } from '@threadgarden/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeLogin,
  SIGN_IN_TIMEOUT_MS,
  removeTranscript,
  type ClaudeLoginDeps,
  type LoginChat,
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

const chat = (sessionId: string, s: FakeSession): LoginChat => ({
  sessionId,
  loginProcess: () => s,
});

const setup = (over: Partial<ClaudeLoginDeps> = {}) => {
  const timers = new ManualTimers();
  const helpers: FakeSession[] = [];
  const emitted: ClaudeAccount[] = [];
  const noted: UsageAccount[] = [];
  const reports: string[] = [];
  let restarts = 0;
  let stored: UsageAccount | null = { kind: 'login', email: 'old@example.com', plan: 'pro' };
  const chats: LoginChat[] = [];
  const login = new ClaudeLogin({
    account: () => stored,
    noteAccount: (a) => {
      noted.push(a);
      stored = a;
    },
    liveClaude: () => chats,
    startHelper: async () => {
      const s = fakeSession();
      helpers.push(s);
      return s;
    },
    restartAfterSignIn: () => void restarts++,
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
    emitted,
    noted,
    reports,
    chats,
    restarts: () => restarts,
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
  it('start runs on the named chat’s process when it is live, else on a helper', async () => {
    const ctx = setup();
    const own = fakeSession();
    ctx.chats.push(chat('chat-1', own));

    expect(await ctx.login.start('chat-1')).toEqual({ url: LINK });
    expect(own.loginCalls).toEqual([{ op: 'start' }]);
    expect(ctx.helpers).toHaveLength(0);
    expect(ctx.login.state().signingIn).toBe(true);

    // A chat that isn't live (or isn't known) runs it on a helper process.
    expect(await ctx.login.start('gone')).toEqual({ url: LINK });
    expect(ctx.helpers).toHaveLength(1);
    expect(ctx.helpers[0]!.loginCalls).toEqual([{ op: 'start' }]);
    expect(ctx.helpers[0]!.sent).toEqual([]); // no prompt
    // The chat's own process is never closed by the sign-in.
    expect(own.closed).toBe(false);
  });

  it('start without a chat uses a live Claude chat when there is one, else a helper', async () => {
    const ctx = setup();
    expect(await ctx.login.start()).toEqual({ url: LINK });
    expect(ctx.helpers).toHaveLength(1);
    await ctx.login.cancel();

    const own = fakeSession();
    ctx.chats.push(chat('chat-1', own));
    await ctx.login.start();
    expect(own.loginCalls).toEqual([{ op: 'start' }]);
    expect(ctx.helpers).toHaveLength(1);
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
    ctx.chats.push(chat('slow', slow));
    const firstStart = ctx.login.start('slow');
    await settle();
    await ctx.login.start('other'); // a helper
    release({ manualUrl: LINK });
    const err = await rejection(firstStart);
    expect(err.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.message).not.toContain(STATE);
    expect(ctx.login.state().signingIn).toBe(true);
    expect(ctx.helpers[0]!.closed).toBe(false);
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
    expect(ctx.restarts()).toBe(1);
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
    other.chats.push(chat('c', s));
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
