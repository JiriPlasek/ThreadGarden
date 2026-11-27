/**
 * Signing in to Claude Code on this machine (protocol 14), with the SDK's
 * undeclared login controls (`LoginControls`; spike results in
 * docs/superpowers/specs/2026-11-27-claude-sign-in-spike-results.md).
 *
 * - **Where it runs:** always on a short-lived helper process in the home folder
 *   that never gets a prompt, also for a sign-in from a chat (its id only says
 *   which chat asked): a chat's own process may be reclaimed or restarted in the
 *   middle of it. The helper is closed when the sign-in ends: on success,
 *   failure, cancel, a newer start or after `SIGN_IN_TIMEOUT_MS`.
 * - **The link:** `start()` answers `{ manualUrl, automaticUrl }` (AUTH_START). Only
 *   the manual one works from another device (its page shows the code to paste);
 *   the automatic one calls back to localhost on this machine. The sign-in's
 *   `state` is the manual link's `state` parameter. No code goes to Claude Code
 *   before it gave the link.
 * - **The code:** claude.ai shows `code#state` or just the code. Whitespace is
 *   dropped; a pasted state must be this sign-in's. `wait()` is started with
 *   `submit()`: it resolves on success, and rejects with Claude Code's words on a
 *   wrong code, which ends the flow in Claude Code (spike L2): so every failure
 *   ends the sign-in here too, and a new one needs a new start. A second code
 *   while one is being checked is not sent: it gets that check's answer.
 * - **After it:** the account is read from that process and handed to usage
 *   (its stored account is what `claude.account` reports), and the live Claude
 *   chats restart between turns (`OTHERS_PICK_UP`: running processes keep the old
 *   login). A sign-in replaced or cancelled meanwhile restarts nothing.
 * - **Signing out** (`/logout`) restarts every live Claude chat, whatever
 *   `OTHERS_PICK_UP` says, so none keeps using the old login.
 *
 * Secrets: the code, the links and the state never reach a log line, a report,
 * an event or an error message. Errors are `ServiceError`s (the router never
 * logs those) whose text is scrubbed of them, of any address and of long tokens.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_LOGIN_ERRORS, type ClaudeAccount, type UsageAccount } from '@threadgarden/protocol';
import { realTimers, type Timers } from '../chat/live-session.js';
import type { AgentSession, LoginControls } from '../sdk/adapter.js';
import { isCodexSession } from '../sdk/providers.js';
import { ServiceError } from '../server/router.js';
import { accountOf } from '../usage/usage.js';

/** A sign-in nobody finished is ended after this long (its helper closed). */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** How long reading the new account after a sign-in may take. */
export const ACCOUNT_AFTER_TIMEOUT_MS = 10_000;
/**
 * Whether running Claude Code processes pick up a new login by themselves
 * (spike `OTHERS_PICK_UP`; not run yet, so assumed not): when false, every live
 * Claude chat restarts after a sign-in; when true, only those that failed on login.
 * A sign-out restarts every live Claude chat either way.
 */
export const OTHERS_PICK_UP = false;

/** What the live Claude chats restart after: a sign-in or a sign-out (`/logout`). */
export type LoginChange = 'signIn' | 'signOut';

export type ClaudeLoginDeps = {
  /** Usage's stored account (what this machine's chats last reported). */
  account: () => UsageAccount | null;
  /** Tells usage the account a sign-in ended on. */
  noteAccount: (account: UsageAccount) => void;
  /** A short-lived Claude process in the home folder, with no prompt. */
  startHelper: () => Promise<AgentSession>;
  /** `SessionHost.restartAfterLoginChange`. */
  restartChats: (after: LoginChange) => void;
  /** Runs Claude Code's `claude auth logout` on this machine; rejects with its words. */
  logout: () => Promise<void>;
  /** Usage forgets the stored account (and its windows) after a logout. */
  forgetAccount: () => void;
  /**
   * Why this machine has no Claude sign-in although usage hasn't said so (an API
   * key setting, a key or a provider in the chats' environment: `envRefusal`);
   * undefined when it can sign in. Asked at every start, so it must be cheap.
   */
  refusal?: () => string | undefined;
  /** The `claude.account` event. */
  emit: (s: ClaudeAccount) => void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Contained failures; never handed anything that could carry a secret. */
  onError?: (err: unknown, context: string) => void;
};

type Flow = {
  /** Set once it has started (asynchronously). */
  helper?: AgentSession;
  state?: string;
  /** Claude Code answered with the link: a code may go in. */
  ready: boolean;
  timer: unknown;
  over: boolean;
  /** Why it ended: what an answer arriving after that gets. */
  endReason?: string;
  /** The code check in progress; a second code joins it. */
  checking?: Promise<{ account: UsageAccount | null }>;
  /** Rejects when the flow ends, so nothing waits on a dead sign-in. */
  ended: Promise<never>;
  end: (err: ServiceError) => void;
  /** The links: never shown. */
  secrets: string[];
};

const failed = (message: string): ServiceError =>
  new ServiceError(CLAUDE_LOGIN_ERRORS.failed, message);

const ENDED = {
  cancelled: 'The sign-in was cancelled.',
  replaced: 'A newer sign-in replaced this one.',
  timeout: 'The sign-in timed out. Sign in again to get a new link.',
  exited: 'Claude Code stopped before the sign-in finished. Sign in again.',
  done: 'The sign-in finished.',
} as const;

/** Environment switches that send Claude Code to a cloud provider instead of claude.ai. */
const PROVIDER_SWITCHES = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

const isOn = (v: string | undefined): boolean =>
  v !== undefined && v.trim() !== '' && !['0', 'false'].includes(v.trim().toLowerCase());

/**
 * Why a chat started with `env` would not use a Claude sign-in: an API key in it
 * (Threadgarden's own key setting is put there too) or a cloud provider switch.
 * Undefined when nothing in it stands in the way. Names match as on Windows.
 */
export const envRefusal = (env: Record<string, string | undefined>): string | undefined => {
  const get = (name: string): string | undefined => {
    for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === name) return v;
    return undefined;
  };
  if (isOn(get('ANTHROPIC_API_KEY'))) {
    return 'This machine uses an API key, so it has no Claude sign-in.';
  }
  if (PROVIDER_SWITCHES.some((k) => isOn(get(k)))) {
    return 'This machine uses a cloud provider, so it has no Claude sign-in.';
  }
  return undefined;
};

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `message` without the given secrets, any address and any long token. A secret
 * is matched only as a whole token, so a short pasted word does not cut words apart.
 */
export const scrub = (message: string, secrets: readonly (string | undefined)[]): string => {
  let out = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '(link)');
  const known = [...new Set(secrets.filter((s): s is string => !!s))].sort(
    (a, b) => b.length - a.length,
  );
  for (const s of known) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escape(s)}(?![A-Za-z0-9_-])`, 'g'), '…');
  }
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, '…').trim();
  return out === '' ? 'The sign-in failed.' : out;
};

/** The manual link's `state` parameter (AUTH_START); undefined when it has none. */
const stateOf = (link: string): string | undefined => {
  try {
    return new URL(link).searchParams.get('state') ?? undefined;
  } catch {
    return undefined;
  }
};

export class ClaudeLogin {
  private flow: Flow | undefined;
  /** Why the last sign-in ended by itself (timeout, its process gone): the next code is told. */
  private lastEnd: string | undefined;
  private expired = false;
  private published = '';
  private readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;

  constructor(private readonly deps: ClaudeLoginDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  state(): ClaudeAccount {
    return {
      account: this.deps.account() ?? null,
      expired: this.expired,
      signingIn: this.flow !== undefined,
    };
  }

  /** Sends `claude.account` when the state changed since it was last sent. */
  publish(): void {
    const s = this.state();
    const key = JSON.stringify(s);
    if (key === this.published) return;
    this.published = key;
    try {
      this.deps.emit(s);
    } catch (err) {
      this.report(err, 'claude.account event');
    }
  }

  /** A chat's turn failed on login (`false`), or worked again after one (`true`). */
  noteLogin(ok: boolean): void {
    this.expired = !ok;
    this.publish();
  }

  /** `sessionId`: the chat that asked; it never runs the sign-in (the helper does). */
  async start(sessionId?: string): Promise<{ url: string }> {
    if (sessionId !== undefined && isCodexSession(sessionId)) {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.unsupported,
        "Codex chats don't sign in to Claude.",
      );
    }
    const account = this.deps.account();
    if (account?.kind === 'apiKey') {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.unsupported,
        'This machine uses an API key, so it has no Claude sign-in.',
      );
    }
    if (account?.kind === 'provider') {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.unsupported,
        `This machine uses ${account.provider ?? 'a cloud provider'}, so it has no Claude sign-in.`,
      );
    }
    const refusal = this.deps.refusal?.();
    if (refusal) throw new ServiceError(CLAUDE_LOGIN_ERRORS.unsupported, refusal);
    // One sign-in at a time: a new one replaces the one in progress.
    if (this.flow) this.endFlow(this.flow, ENDED.replaced);
    this.lastEnd = undefined;
    const flow = this.newFlow();
    this.publish();
    try {
      const helper = await this.race(flow, this.deps.startHelper(), (h) => h.close());
      flow.helper = helper;
      this.drain(flow, helper);
      const controls = helper.login;
      if (!controls) throw failed("Claude Code on this machine can't sign in from here.");
      const answer = await this.race(flow, (async () => controls.start())());
      const links = isRec(answer) ? answer : {};
      for (const key of ['manualUrl', 'automaticUrl']) {
        const link = links[key];
        if (typeof link === 'string') flow.secrets.push(link);
      }
      const manual = typeof links.manualUrl === 'string' ? links.manualUrl : undefined;
      if (!manual) throw failed("Claude Code didn't give a sign-in link.");
      flow.state = stateOf(manual);
      if (flow.state) flow.secrets.push(flow.state);
      flow.ready = true;
      return { url: manual };
    } catch (err) {
      if (this.flow === flow) {
        this.endFlow(flow, ENDED.cancelled);
        this.publish();
      }
      throw this.failure(err, flow.secrets);
    }
  }

  /**
   * Checks a pasted code. Every failure ends the sign-in. A code before the
   * link is out is refused and changes nothing; a second code while one is
   * being checked is not sent and gets that check's answer.
   */
  async submit(code: string): Promise<{ account: UsageAccount | null }> {
    const flow = this.flow;
    if (!flow) {
      const reason = this.lastEnd;
      this.lastEnd = undefined;
      if (reason) throw failed(reason);
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.notStarted,
        'No sign-in is in progress. Sign in again to get a new link.',
      );
    }
    const controls = flow.helper?.login;
    if (!flow.ready || !controls) {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.notStarted,
        "The sign-in link isn't ready yet. Paste the code once the link is there.",
      );
    }
    flow.checking ??= this.check(flow, controls, code);
    return flow.checking;
  }

  /** Ends the sign-in in progress; nothing happens when there is none. */
  async cancel(): Promise<void> {
    this.lastEnd = undefined;
    const flow = this.flow;
    if (!flow) return;
    this.endFlow(flow, ENDED.cancelled);
    this.publish();
  }

  /**
   * `/logout`: ends a sign-in in progress, runs `claude auth logout` on this
   * machine, forgets the account and restarts every live Claude chat so they
   * drop the old login. A machine on an API key or a provider has no sign-in to end.
   */
  async signOut(): Promise<void> {
    const account = this.deps.account();
    if (account?.kind === 'apiKey' || account?.kind === 'provider') {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.unsupported,
        account.kind === 'apiKey'
          ? 'This machine uses an API key, so it has no Claude sign-in.'
          : `This machine uses ${account.provider ?? 'a cloud provider'}, so it has no Claude sign-in.`,
      );
    }
    const refusal = this.deps.refusal?.();
    if (refusal) throw new ServiceError(CLAUDE_LOGIN_ERRORS.unsupported, refusal);
    await this.cancel();
    try {
      await this.deps.logout();
    } catch (err) {
      throw this.failure(err, []);
    }
    this.deps.forgetAccount();
    this.expired = false;
    this.publish();
    try {
      this.deps.restartChats('signOut');
    } catch (err) {
      this.report(err, 'restart after signing out');
    }
  }

  /** At shutdown: ends a sign-in in progress and its timer. */
  dispose(): void {
    if (this.flow) this.endFlow(this.flow, ENDED.cancelled);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async check(
    flow: Flow,
    controls: LoginControls,
    code: string,
  ): Promise<{ account: UsageAccount | null }> {
    const pasted = code.replace(/\s+/g, '');
    const hash = pasted.indexOf('#');
    const theCode = hash >= 0 ? pasted.slice(0, hash) : pasted;
    const pastedState = hash >= 0 ? pasted.slice(hash + 1) : undefined;
    const secrets = [...flow.secrets, code.trim(), pasted, theCode, pastedState];
    try {
      if (theCode === '') throw failed('Paste the code claude.ai shows you.');
      if (pastedState !== undefined && flow.state !== undefined && pastedState !== flow.state) {
        throw failed(
          'That code is from a different sign-in. Sign in again and paste the code it gives you.',
        );
      }
      const state = pastedState ?? flow.state;
      if (!state) throw failed('Paste the whole code claude.ai shows you.');
      // The wait is held while the code goes in (spike L2/L4): it settles with the outcome.
      const waiting = (async () => controls.wait())();
      waiting.catch(() => {});
      await this.race(flow, (async () => controls.submit(theCode, state))());
      await this.race(flow, waiting);
    } catch (err) {
      if (this.flow === flow) {
        this.endFlow(flow, ENDED.cancelled);
        this.publish();
      }
      throw this.failure(err, secrets);
    }
    const account = await this.accountAfter(flow.helper!);
    // Replaced or cancelled meanwhile: a newer sign-in (or none) decides what happens next.
    if (flow.over) throw failed(flow.endReason ?? ENDED.cancelled);
    this.endFlow(flow, ENDED.done);
    this.expired = false;
    this.publish();
    try {
      this.deps.restartChats('signIn');
    } catch (err) {
      this.report(err, 'restart after signing in');
    }
    return { account };
  }

  private newFlow(): Flow {
    let end: (err: ServiceError) => void = () => {};
    const ended = new Promise<never>((_resolve, reject) => {
      end = reject;
    });
    ended.catch(() => {});
    const flow: Flow = {
      ready: false,
      timer: undefined,
      over: false,
      ended,
      end,
      secrets: [],
    };
    flow.timer = this.timers.setTimeout(
      () => this.endedByItself(flow, ENDED.timeout),
      SIGN_IN_TIMEOUT_MS,
    );
    this.flow = flow;
    return flow;
  }

  /** The current sign-in ended without being asked to: the next code is told why. */
  private endedByItself(flow: Flow, reason: string): void {
    if (this.flow !== flow) return;
    this.endFlow(flow, reason);
    this.lastEnd = reason;
    this.publish();
  }

  private endFlow(flow: Flow, reason: string): void {
    if (flow.over) return;
    flow.over = true;
    flow.endReason = reason;
    this.timers.clearTimeout(flow.timer);
    flow.end(failed(reason));
    if (this.flow === flow) this.flow = undefined;
    if (flow.helper) {
      try {
        flow.helper.close();
      } catch (err) {
        this.report(err, 'closing the sign-in process');
      }
    }
  }

  /**
   * `work`, unless the flow ends first. A result that arrives after the flow
   * ended is handed to `late` (a helper that started too late is closed).
   */
  private race<T>(flow: Flow, work: Promise<T>, late?: (value: T) => void): Promise<T> {
    if (late) {
      void work.then(
        (v) => {
          if (flow.over) late(v);
        },
        () => {},
      );
    }
    return Promise.race([work, flow.ended]);
  }

  /** Reads the helper's messages (nobody else does); its end ends the sign-in. */
  private drain(flow: Flow, helper: AgentSession): void {
    void (async () => {
      try {
        for await (const m of helper.messages) void m;
      } catch {
        // Its end is what matters.
      }
      this.endedByItself(flow, ENDED.exited);
    })();
  }

  /**
   * The account the sign-in ended on, read from its process and given to usage.
   * A process that does not report the new login yet (no email: spike, before a
   * sign-in `tokenSource` is `none`), or a failed read, leaves the stored one.
   */
  private async accountAfter(process: AgentSession): Promise<UsageAccount | null> {
    let timer: unknown;
    try {
      const info = await Promise.race([
        process.accountInfo(),
        new Promise<never>((_resolve, reject) => {
          timer = this.timers.setTimeout(
            () => reject(new Error('timed out')),
            ACCOUNT_AFTER_TIMEOUT_MS,
          );
        }),
      ]);
      const account = accountOf(info);
      if (account.kind !== 'login' || account.email) this.deps.noteAccount(account);
    } catch {
      // Its message is the SDK's; only the fact is reported.
      this.report(new Error('could not read the account after signing in'), 'claude sign-in');
    } finally {
      this.timers.clearTimeout(timer);
    }
    return this.deps.account();
  }

  private failure(err: unknown, secrets: readonly (string | undefined)[]): ServiceError {
    if (err instanceof ServiceError) return new ServiceError(err.code, scrub(err.message, secrets));
    const message = err instanceof Error ? err.message : String(err);
    return failed(scrub(message, secrets));
  }

  private report(err: unknown, context: string): void {
    try {
      this.deps.onError?.(err, context);
    } catch {
      // Nothing left to tell.
    }
  }
}

/**
 * Deletes a helper process's transcript (`<projects>/<folder>/<id>.jsonl` and its
 * `<id>/` folder of subagents), wherever Claude Code put it. A helper gets no
 * prompt, so Claude Code should write none; this makes sure no helper chat is left.
 */
export const removeTranscript = async (projectsDir: string, sessionId: string): Promise<void> => {
  let folders: string[];
  try {
    folders = await readdir(projectsDir);
  } catch {
    return;
  }
  await Promise.all(
    folders.flatMap((f) =>
      [`${sessionId}.jsonl`, sessionId].map((name) =>
        // A stray file among the folders, say: nothing to remove there.
        rm(join(projectsDir, f, name), { recursive: true, force: true }).catch(() => {}),
      ),
    ),
  );
};
