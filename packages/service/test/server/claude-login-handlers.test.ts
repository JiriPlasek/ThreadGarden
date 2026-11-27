/** The claude.* methods against the real service wiring and a fake adapter. */
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_LOGIN_CAPABILITY,
  CLAUDE_LOGIN_ERRORS,
  PROTOCOL_VERSION,
  type ClaudeAccount,
  type EventMsg,
} from '@threadgarden/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/logger.js';
import { startService, type ServiceHandle } from '../../src/main.js';
import type { AccountInfo, StartOptions } from '../../src/sdk/adapter.js';
import { FakeAdapter, type FakeSession } from '../../src/testing/fake-adapter.js';
import { eventually, TestClient } from '../e2e/ws-client.js';
import { init, result, settle } from '../chat/live-helpers.js';

const STATE = 'S7aTeS7aTeS7aTeS7aTeS7aTeS7aTeS7aTeS7aTe123';
const LINK = `https://claude.com/cai/oauth/authorize?code=true&client_id=c1&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=${STATE}`;
const CODE = 'c0deC0deC0de-_c0de';

let dir: string;
let svc: ServiceHandle | undefined;
let client: TestClient | undefined;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'threadgarden-login-'));
  logs = [];
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await svc?.close();
  svc = undefined;
  await rm(dir, { recursive: true, force: true });
});

const logger: Logger = {
  debug: (m) => void logs.push(m),
  info: (m) => void logs.push(m),
  warn: (m) => void logs.push(m),
  error: (m) => void logs.push(m),
  flush: async () => {},
};

/** Every session gets a sign-in link and answers `accountInfo()` with `account`. */
class LoginAdapter extends FakeAdapter {
  account: AccountInfo = { tokenSource: 'claude.ai', email: 'me@example.com' };
  override start(o: StartOptions): FakeSession {
    const s = super.start(o);
    s.loginStart = { manualUrl: LINK, automaticUrl: 'http://localhost:1/callback' };
    s.account = this.account;
    return s;
  }
}

const start = async (
  adapter: FakeAdapter,
  extra: { claudeLogout?: () => Promise<void>; apiKeyOnly?: boolean } = {},
) => {
  svc = await startService({
    dataDir: join(dir, 'data'),
    claudeConfigDir: join(dir, 'claude'),
    adapter,
    claude: { path: '/bin/claude', version: '2.1.330' },
    externalRun: async () => '[]',
    sessionEnv: { PATH: '/usr/bin' },
    installSignalHandlers: false,
    logger,
    ...extra,
  });
  client = await TestClient.connect(svc.port, svc.token);
  return client;
};

/** A chat whose process has started and told its account. */
const liveChat = async (c: TestClient, adapter: FakeAdapter) => {
  const { sessionId } = await c.call<{ sessionId: string }>('chat.create', {
    cwd: dir,
    text: 'hi',
  });
  const fake = adapter.lastSession();
  fake.emit(init(sessionId));
  fake.emit(result(`r-${sessionId}`));
  await settle();
  return { sessionId, fake };
};

const accountEvents = (c: TestClient): ClaudeAccount[] =>
  c.events
    .filter((e: EventMsg) => e.event === 'claude.account')
    .map((e) => e.data as ClaudeAccount);

describe('claude.*', () => {
  it('hello advertises the capability', async () => {
    const c = await start(new LoginAdapter());
    const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', {
      protocolVersion: PROTOCOL_VERSION,
      client: 't',
    });
    expect(hello.machine.capabilities).toContain(CLAUDE_LOGIN_CAPABILITY);
  });

  it('the API-key-only build offers no sign-in and refuses one, and a sign-out', async () => {
    const adapter = new LoginAdapter();
    const logouts: number[] = [];
    const c = await start(adapter, {
      apiKeyOnly: true,
      claudeLogout: async () => void logouts.push(1),
    });
    const hello = await c.call<{ machine: { capabilities: string[] } }>('hello', {
      protocolVersion: PROTOCOL_VERSION,
      client: 't',
    });
    expect(hello.machine.capabilities).not.toContain(CLAUDE_LOGIN_CAPABILITY);
    for (const method of ['claude.signIn', 'claude.signOut']) {
      const err = await c.raw(method, {});
      expect(err.error?.code).toBe(CLAUDE_LOGIN_ERRORS.unsupported);
      expect(err.error?.message).toContain('API key');
    }
    expect(adapter.started).toHaveLength(0);
    expect(logouts).toEqual([]);
  });

  it('claude.account says what the chats last reported', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    expect(await c.call('claude.account', {})).toEqual({
      account: null,
      expired: false,
      signingIn: false,
    });
    await liveChat(c, adapter);
    await eventually(async () =>
      expect(await c.call('claude.account', {})).toEqual({
        account: { kind: 'login', email: 'me@example.com' },
        expired: false,
        signingIn: false,
      }),
    );
    // The usage tracker's account change is announced as a claude.account event too.
    await c.waitFor((e) => e.event === 'claude.account');
  });

  it('a chat failing on login marks the sign-in expired', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    const { sessionId, fake } = await liveChat(c, adapter);
    await c.call('chat.send', { sessionId, text: 'go' });
    fake.emit({
      type: 'assistant',
      uuid: 'a-x',
      session_id: 's',
      parent_tool_use_id: null,
      error: 'authentication_failed',
      message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'Not logged in' }] },
    } as never);
    fake.emit(result('r-x', { is_error: true, result: 'Not logged in · Please run /login' }));
    await c.waitFor(
      (e) => e.event === 'claude.account' && (e.data as ClaudeAccount).expired === true,
    );
    expect((await c.call<ClaudeAccount>('claude.account', {})).expired).toBe(true);
  });

  it('claude.signIn starts a helper process in the home folder, kept out of the chats', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    expect(await c.call('claude.signIn', {})).toEqual({ url: LINK });
    const helper = adapter.lastSession();
    expect(helper.options.cwd).toBe(homedir());
    expect(helper.sent).toEqual([]);
    expect(helper.loginCalls).toEqual([{ op: 'start' }]);
    expect(svc!.host!.list()).toEqual([]);
    await c.waitFor(
      (e) => e.event === 'claude.account' && (e.data as ClaudeAccount).signingIn === true,
    );
    expect((await c.call<ClaudeAccount>('claude.account', {})).signingIn).toBe(true);
  });

  it('a sign-in from a chat runs on a helper and survives that chat restarting', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    const { sessionId, fake } = await liveChat(c, adapter);
    expect(await c.call('claude.signIn', { sessionId })).toEqual({ url: LINK });
    const helper = adapter.lastSession();
    expect(helper).not.toBe(fake);
    expect(helper.options.cwd).toBe(homedir());
    expect(helper.loginCalls).toEqual([{ op: 'start' }]);
    expect(fake.loginCalls).toEqual([]);
    // The chat restarts (a pending restart, an idle reclaim): the sign-in goes on.
    expect(svc!.host!.restartWhenIdle(sessionId)).toBe(true);
    expect(fake.closed).toBe(true);
    await settle();
    expect((await c.call<ClaudeAccount>('claude.account', {})).signingIn).toBe(true);
    helper.accountAfterLogin = { tokenSource: 'claude.ai', email: 'new@example.com' };
    expect(await c.call('claude.signInCode', { code: CODE })).toEqual({
      account: { kind: 'login', email: 'new@example.com' },
    });
    expect(helper.loginCalls.map((x) => x.op)).toEqual(['start', 'wait', 'submit']);
    expect(helper.closed).toBe(true);
  });

  it('claude.signInCode signs in and restarts the live chats', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    const { sessionId, fake } = await liveChat(c, adapter);
    await c.call('claude.signIn', {});
    // From Settings: a helper, even with a chat live.
    const helper = adapter.lastSession();
    expect(helper).not.toBe(fake);
    expect(fake.loginCalls).toEqual([]);
    helper.accountAfterLogin = {
      tokenSource: 'claude.ai',
      email: 'new@example.com',
      subscriptionType: 'max',
    };
    expect(await c.call('claude.signInCode', { code: ` ${CODE}\n` })).toEqual({
      account: { kind: 'login', email: 'new@example.com', plan: 'max' },
    });
    expect(helper.closed).toBe(true);
    expect(fake.closed).toBe(true);
    expect(adapter.lastSession().options.resume).toBe(sessionId);
    await c.waitFor(
      (e) =>
        e.event === 'claude.account' &&
        (e.data as ClaudeAccount).account?.email === 'new@example.com' &&
        !(e.data as ClaudeAccount).signingIn,
    );
  });

  it('claude.signInCode without a sign-in answers LOGIN_NOT_STARTED', async () => {
    const c = await start(new LoginAdapter());
    await expect(c.call('claude.signInCode', { code: CODE })).rejects.toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.notStarted,
    });
  });

  it('a wrong code answers LOGIN_FAILED in Claude Code’s words, and ends the sign-in', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    await c.call('claude.signIn', {});
    const helper = adapter.lastSession();
    helper.loginError = new Error(`That code wasn't accepted (${CODE}, ${STATE}, ${LINK}).`);
    const err = await c.raw('claude.signInCode', { code: `${CODE}#${STATE}` });
    expect(err.error?.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.error?.message).toContain("That code wasn't accepted");
    expect((await c.call<ClaudeAccount>('claude.account', {})).signingIn).toBe(false);
    expect(helper.closed).toBe(true);
    // Never in a log line, an event or the answer.
    await settle();
    const seen = [JSON.stringify(err), logs.join('\n'), JSON.stringify(c.events)].join('\n');
    for (const secret of [CODE, STATE, 'claude.com/cai']) expect(seen).not.toContain(secret);
  });

  it('claude.signInCancel closes the helper, also twice and with nothing open', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    expect(await c.call('claude.signInCancel', {})).toEqual({});
    await c.call('claude.signIn', {});
    const helper = adapter.lastSession();
    expect(await c.call('claude.signInCancel', {})).toEqual({});
    expect(await c.call('claude.signInCancel', {})).toEqual({});
    expect(helper.closed).toBe(true);
    expect((await c.call<ClaudeAccount>('claude.account', {})).signingIn).toBe(false);
    expect(accountEvents(c).map((s) => s.signingIn)).toEqual([true, false]);
  });

  it('claude.signOut runs the logout, clears the account and restarts the live chats', async () => {
    const adapter = new LoginAdapter();
    const logouts: number[] = [];
    const c = await start(adapter, { claudeLogout: async () => void logouts.push(1) });
    const { sessionId, fake } = await liveChat(c, adapter);
    await c.call('claude.signIn', {});
    const helper = adapter.lastSession();
    expect(await c.call('claude.signOut', {})).toEqual({});
    expect(logouts).toEqual([1]);
    expect(helper.closed).toBe(true);
    expect(fake.closed).toBe(true);
    expect(adapter.lastSession().options.resume).toBe(sessionId);
    expect(await c.call<ClaudeAccount>('claude.account', {})).toEqual({
      account: null,
      expired: false,
      signingIn: false,
    });
  });

  it('claude.signOut answers LOGIN_FAILED with the CLI words, and LOGIN_UNSUPPORTED on an API key', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter, {
      claudeLogout: async () => {
        throw new Error('not logged in');
      },
    });
    const err = await c.raw('claude.signOut', {});
    expect(err.error?.code).toBe(CLAUDE_LOGIN_ERRORS.failed);
    expect(err.error?.message).toBe('not logged in');
    await c.call('auth.setApiKey', { key: 'sk-ant-secret-key' });
    const refused = await c.raw('claude.signOut', {});
    expect(refused.error?.code).toBe(CLAUDE_LOGIN_ERRORS.unsupported);
    expect(refused.error?.message).not.toContain('sk-ant');
  });

  it('an API key setting refuses sign-in', async () => {
    const adapter = new LoginAdapter();
    const c = await start(adapter);
    await c.call('auth.setApiKey', { key: 'sk-ant-secret-key' });
    const err = await c.raw('claude.signIn', {});
    expect(err.error?.code).toBe(CLAUDE_LOGIN_ERRORS.unsupported);
    expect(err.error?.message).not.toContain('sk-ant');
    expect(adapter.started).toHaveLength(0);
    await c.call('auth.setApiKey', { key: null });
    expect(await c.call('claude.signIn', {})).toEqual({ url: LINK });
  });

  it('a cloud provider in the environment refuses sign-in', async () => {
    const adapter = new LoginAdapter();
    svc = await startService({
      dataDir: join(dir, 'data'),
      claudeConfigDir: join(dir, 'claude'),
      adapter,
      claude: { path: '/bin/claude', version: '2.1.330' },
      externalRun: async () => '[]',
      sessionEnv: { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1' },
      installSignalHandlers: false,
      logger,
    });
    client = await TestClient.connect(svc.port, svc.token);
    await expect(client.call('claude.signIn', {})).rejects.toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
    });
  });

  it('an API-key machine and a Codex chat answer LOGIN_UNSUPPORTED', async () => {
    const adapter = new LoginAdapter();
    adapter.account = { apiKeySource: 'ANTHROPIC_API_KEY' };
    const c = await start(adapter);
    await liveChat(c, adapter);
    await eventually(async () =>
      expect((await c.call<ClaudeAccount>('claude.account', {})).account?.kind).toBe('apiKey'),
    );
    await expect(c.call('claude.signIn', {})).rejects.toMatchObject({
      code: CLAUDE_LOGIN_ERRORS.unsupported,
    });

    const other = new LoginAdapter();
    await client?.close();
    await svc?.close();
    await rm(join(dir, 'data'), { recursive: true, force: true });
    const d = await start(other);
    await expect(
      d.call('claude.signIn', { sessionId: 'codex-00000000-0000-0000-0000-000000000000' }),
    ).rejects.toMatchObject({ code: CLAUDE_LOGIN_ERRORS.unsupported });
    expect(other.started).toHaveLength(0);
  });
});
