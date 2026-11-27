/**
 * Signing in to Claude Code on this machine (protocol 14), with the SDK's
 * undeclared login controls (`LoginControls`; spike results in
 * docs/superpowers/specs/2026-11-27-claude-sign-in-spike-results.md).
 *
 * - **Where it runs:** on the named chat's process when that chat is live, else
 *   on any live Claude chat's, else on a short-lived helper process in the home
 *   folder that never gets a prompt. The helper is closed when the sign-in ends:
 *   on success, failure, cancel, a newer start or after `SIGN_IN_TIMEOUT_MS`.
 * - **The link:** `start()` answers `{ manualUrl, automaticUrl }` (AUTH_START). Only
 *   the manual one works from another device (its page shows the code to paste);
 *   the automatic one calls back to localhost on this machine. The sign-in's
 *   `state` is the manual link's `state` parameter.
 * - **The code:** claude.ai shows `code#state` or just the code. Whitespace is
 *   dropped; a pasted state must be this sign-in's. `wait()` is started with
 *   `submit()`: it resolves on success, and rejects with Claude Code's words on a
 *   wrong code, which ends the flow in Claude Code (spike L2): so every failure
 *   ends the sign-in here too, and a new one needs a new start.
 * - **After it:** the account is read from that process and handed to usage
 *   (its stored account is what Settings shows), and the live Claude chats
 *   restart between turns (`OTHERS_PICK_UP`: running processes keep the old login).
 *
 * Secrets: the code, the links and the state never reach a log line, a report,
 * an event or an error message. Errors are `ServiceError`s (the router never
 * logs those) whose text is scrubbed of them, of any address and of long tokens.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_LOGIN_ERRORS, type ClaudeAccount, type UsageAccount } from '@threadgarden/protocol';
import { realTimers, type Timers } from '../chat/live-session.js';
import type { AccountInfo, AgentSession, LoginControls } from '../sdk/adapter.js';
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
 */
export const OTHERS_PICK_UP = false;

/** A process that can run a sign-in: a live chat's, or the helper. */
export type LoginProcess = {
  readonly login?: LoginControls;
  accountInfo(): Promise<AccountInfo>;
};

/** A live Claude chat, as far as a sign-in needs it (`LiveSession`). */
export type LoginChat = {
  readonly sessionId: string;
  loginProcess(): LoginProcess | undefined;
};

export type ClaudeLoginDeps = {
  /** Usage's stored account (what this machine's chats last reported). */
  account: () => UsageAccount | null;
  /** Tells usage the account a sign-in ended on. */
  noteAccount: (account: UsageAccount) => void;
  /** This machine's live Claude chats. */
  liveClaude: () => LoginChat[];
  /** A short-lived Claude process in the home folder, with no prompt. */
  startHelper: () => Promise<AgentSession>;
  /** `SessionHost.restartAfterSignIn`. */
  restartAfterSignIn: () => void;
  /** The `claude.account` event. */
  emit: (s: ClaudeAccount) => void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** Contained failures; never handed anything that could carry a secret. */
  onError?: (err: unknown, context: string) => void;
};

type Flow = {
  /** Set once the process is known (a helper starts asynchronously). */
  process?: LoginProcess;
  helper?: AgentSession;
  state?: string;
  timer: unknown;
  over: boolean;
  checking: boolean;
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
} as const;

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
    // One sign-in at a time: a new one replaces the one in progress.
    if (this.flow) this.endFlow(this.flow, ENDED.replaced);
    const flow = this.newFlow();
    this.publish();
    try {
      let process = this.chatProcess(sessionId);
      if (!process) {
        const helper = await this.race(flow, this.deps.startHelper(), (h) => h.close());
        flow.helper = helper;
        this.drain(flow, helper);
        process = helper;
      }
      flow.process = process;
      const controls = process.login;
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
      return { url: manual };
    } catch (err) {
      if (this.flow === flow) {
        this.endFlow(flow, ENDED.cancelled);
        this.publish();
      }
      throw this.failure(err, flow.secrets);
    }
  }

  async submit(code: string): Promise<{ account: UsageAccount | null }> {
    const flow = this.flow;
    const controls = flow?.process?.login;
    if (!flow || !controls) {
      throw new ServiceError(
        CLAUDE_LOGIN_ERRORS.notStarted,
        'No sign-in is in progress. Sign in again to get a new link.',
      );
    }
    if (flow.checking) throw failed('A code for this sign-in is already being checked.');
    const pasted = code.replace(/\s+/g, '');
    const hash = pasted.indexOf('#');
    const theCode = hash >= 0 ? pasted.slice(0, hash) : pasted;
    const pastedState = hash >= 0 ? pasted.slice(hash + 1) : undefined;
    const secrets = [...flow.secrets, code.trim(), pasted, theCode, pastedState];
    flow.checking = true;
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
    const account = await this.accountAfter(flow.process!);
    this.endFlow(flow, ENDED.cancelled);
    this.expired = false;
    this.publish();
    try {
      this.deps.restartAfterSignIn();
    } catch (err) {
      this.report(err, 'restart after signing in');
    }
    return { account };
  }

  /** Ends the sign-in in progress; nothing happens when there is none. */
  async cancel(): Promise<void> {
    const flow = this.flow;
    if (!flow) return;
    this.endFlow(flow, ENDED.cancelled);
    this.publish();
  }

  /** At shutdown: ends a sign-in in progress and its timer. */
  dispose(): void {
    if (this.flow) this.endFlow(this.flow, ENDED.cancelled);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private newFlow(): Flow {
    let end: (err: ServiceError) => void = () => {};
    const ended = new Promise<never>((_resolve, reject) => {
      end = reject;
    });
    ended.catch(() => {});
    const flow: Flow = {
      timer: undefined,
      over: false,
      checking: false,
      ended,
      end,
      secrets: [],
    };
    flow.timer = this.timers.setTimeout(() => {
      if (flow.over) return;
      this.endFlow(flow, ENDED.timeout);
      this.publish();
    }, SIGN_IN_TIMEOUT_MS);
    this.flow = flow;
    return flow;
  }

  private endFlow(flow: Flow, reason: string): void {
    if (flow.over) return;
    flow.over = true;
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

  /** The live chat process to sign in on: the named chat's, or any when none is named. */
  private chatProcess(sessionId: string | undefined): LoginProcess | undefined {
    const chats = this.deps.liveClaude();
    const candidates =
      sessionId === undefined ? chats : chats.filter((c) => c.sessionId === sessionId);
    for (const c of candidates) {
      const p = c.loginProcess();
      if (p?.login) return p;
    }
    return undefined;
  }

  /** Reads the helper's messages (nobody else does); its end ends the sign-in. */
  private drain(flow: Flow, helper: AgentSession): void {
    void (async () => {
      try {
        for await (const m of helper.messages) void m;
      } catch {
        // Its end is what matters.
      }
      if (this.flow === flow) {
        this.endFlow(flow, ENDED.exited);
        this.publish();
      }
    })();
  }

  /**
   * The account the sign-in ended on, read from its process and given to usage.
   * A process that does not report the new login yet (no email: spike, before a
   * sign-in `tokenSource` is `none`), or a failed read, leaves the stored one.
   */
  private async accountAfter(process: LoginProcess): Promise<UsageAccount | null> {
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
