/**
 * v1.2 C1: names for the chats pahub starts. Claude Code titles only its
 * terminal sessions, and a brand-new chat is not indexed yet, so a chat
 * pahub created would read "Untitled chat":
 *
 * - a provisional title at once, from the first message (first sentence of
 *   its first line, as typed — slash commands and @mentions included);
 * - after the chat's first turn, if "Name new chats automatically" is on, a
 *   3–6 word title from a small model (one one-shot `haiku` query through the
 *   user's own Claude Code, nothing persisted, no tools). Any failure keeps
 *   the provisional title, logged at debug level only.
 *
 * Both are pahub's own metadata (`chat_titles`), below the user's custom title
 * (`titleFor`). At most one generation per chat, at most
 * `TITLE_CONCURRENCY` at a time; only chats pahub started (or continued
 * while they had no title at all) are named, never history-only or external ones.
 */
import type { EventMsg } from '@pahub/protocol';
import { FIRST_PROMPT_MAX, UNTITLED_TITLE, titleFor } from '../history/catalog.js';
import type { Db } from '../history/db.js';
import type { AgentAdapter } from '../sdk/adapter.js';
import type { Timers } from './live-session.js';

/** Claude Code's alias of its small fast model (`--model haiku`). */
export const TITLE_MODEL = 'haiku';
export const TITLE_SYSTEM_PROMPT =
  'You name chat conversations. Reply with only a 3–6 word title, no quotes or punctuation at the end.';
/** Most characters of the question sent to the model (message and reply start). */
export const TITLE_INPUT_MAX = 2_000;
export const TITLE_TIMEOUT_MS = 20_000;
export const TITLE_CONCURRENCY = 2;

/** A provisional title cuts at a sentence end only after this many characters. */
const MIN_SENTENCE = 16;
/** Most characters of the reply start when the message alone would fill the question. */
const REPLY_SHARE = 500;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string): string => s.slice(0, FIRST_PROMPT_MAX).trim();

/**
 * The provisional title of a first message: its first non-empty line, cut at
 * the end of its first sentence (unless that sentence is very short), whitespace
 * collapsed, at most 80 characters. Empty for a message without text.
 */
export const provisionalTitle = (text: string): string => {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const flat = collapse(line);
  // A sentence ends at . ! ? followed by a space (not inside `app.ts` or `v1.2`).
  const end = /[.!?](?= )/g;
  let m: RegExpExecArray | null;
  while ((m = end.exec(flat)) !== null) {
    if (m.index + 1 >= MIN_SENTENCE) return cut(flat.slice(0, m.index + 1));
  }
  return cut(flat);
};

const QUOTES = `"'\`“”‘’„«»`;
const EDGE_QUOTES = new RegExp(`^[${QUOTES}]+|[${QUOTES}]+$`, 'g');
const END_PUNCTUATION = /[\s.,;:!?…。]+$/;

/**
 * The model's answer as a title: the first line with content, without a
 * "Title:" label, markdown emphasis, heading marks, surrounding quotes or end
 * punctuation, whitespace collapsed, at most 80 characters. Empty when
 * nothing usable is left.
 */
export const sanitizeTitle = (raw: string): string => {
  const lines = raw
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^#+\s*/, '')
        .replace(/^title\s*:\s*/i, '')
        .replace(/\*\*|__|`/g, ''),
    )
    .filter((l) => l.replace(EDGE_QUOTES, '').trim() !== '');
  let t = collapse(lines[0] ?? '');
  for (let before = ''; before !== t;) {
    before = t;
    t = t
      .replace(/^[*_]+|[*_]+$/g, '')
      .replace(EDGE_QUOTES, '')
      .replace(END_PUNCTUATION, '')
      .trim();
  }
  return cut(t);
};

/**
 * The question for the model: the first message and the start of the first
 * reply, `TITLE_INPUT_MAX` characters in all. A long message leaves room for
 * up to `REPLY_SHARE` characters of the reply. Empty when there is neither.
 */
export const titlePrompt = (first: string, reply: string): string => {
  const message = first.trim();
  const answer = reply.trim();
  if (!message && !answer) return '';
  const head = 'Title this conversation.\n';
  const open = '\n<first_message>\n';
  const middle = '\n</first_message>\n\n<reply_start>\n';
  const close = '\n</reply_start>';
  const budget = TITLE_INPUT_MAX - head.length - open.length - middle.length - close.length;
  const m = message.slice(0, answer ? budget - Math.min(answer.length, REPLY_SHARE) : budget);
  const a = answer.slice(0, budget - m.length);
  return `${head}${open}${m}${middle}${a}${close}`;
};

// ── ChatTitles ────────────────────────────────────────────────────────────────

/** How to run Claude Code for a generation now: the sessions' `claude` and environment. */
export type TitleRun = { claudePath: string; env: Record<string, string | undefined> };

export type ChatTitlesDeps = {
  db: Db;
  adapter: Pick<AgentAdapter, 'oneShot'>;
  /** The `autoTitles` setting, read when a generation is due. */
  enabled: () => boolean;
  /**
   * How to run Claude Code, read when a generation starts; undefined skips it
   * (`claude` not found, or an API-key-only build without a key: exactly
   * when starting a chat would be refused).
   */
  run: () => TitleRun | undefined;
  /** The start of the chat's first assistant reply (empty if none). */
  firstReply: (sessionId: string) => string;
  /** pahub's title of a chat changed (updates cached lists). */
  titleChanged: (sessionId: string) => void;
  /** `sessions.changed` when a generated title arrives. */
  emit: (e: EventMsg) => void;
  /** Failures (never message content): debug level only. */
  debug?: (msg: string) => void;
  timers?: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  timeoutMs?: number;
  concurrency?: number;
};

const unrefTimers: Pick<Timers, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type Pending = { cwd: string; text: string };

export class ChatTitles {
  /** Chats pahub started whose first turn has not ended yet. */
  private readonly pending = new Map<string, Pending>();
  /** Chats a generation was due for in this service run (at most one each). */
  private readonly tried = new Set<string>();
  private readonly queue: (() => Promise<void>)[] = [];
  private readonly running = new Set<AbortController>();
  private readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  private disposed = false;

  constructor(private readonly deps: ChatTitlesDeps) {
    this.timers = deps.timers ?? unrefTimers;
  }

  /**
   * pahub started `sessionId` with `text` (or continued it while it had no
   * title): the provisional title is set now, a generation follows its first
   * turn. True when a provisional title was set (the caller sends `sessions.changed`).
   */
  started(sessionId: string, cwd: string, text: string): boolean {
    // Only what a question can hold is kept (a first message may be a long paste).
    const kept = text.trim().slice(0, TITLE_INPUT_MAX);
    if (!this.tried.has(sessionId)) this.pending.set(sessionId, { cwd, text: kept });
    const title = provisionalTitle(text);
    if (!title) return false;
    this.deps.db.setAutoTitle(sessionId, title);
    this.deps.titleChanged(sessionId);
    return true;
  }

  /** `started` for a chat that has no title of any kind yet; false (nothing done) otherwise. */
  startedIfUntitled(sessionId: string, cwd: string, text: string): boolean {
    const { db } = this.deps;
    const title = titleFor({ ...db.metaOf(sessionId), ...db.getSession(sessionId) });
    if (title !== UNTITLED_TITLE) return false;
    return this.started(sessionId, cwd, text);
  }

  /** A turn of `sessionId` ended: after a started chat's first turn, its title is generated. */
  turnEnded(sessionId: string): void {
    const p = this.pending.get(sessionId);
    if (!p || this.disposed) return;
    this.pending.delete(sessionId);
    if (this.tried.has(sessionId)) return;
    this.tried.add(sessionId);
    if (!this.deps.enabled()) return;
    this.queue.push(() => this.generate(sessionId, p));
    // Later: the turn's end is still being handled when this is called.
    queueMicrotask(() => this.pump());
  }

  /** Aborts running generations and drops queued ones (service shutdown). */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
    this.pending.clear();
    for (const a of this.running) a.abort();
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? TITLE_CONCURRENCY;
    while (!this.disposed && this.running.size < limit) {
      const job = this.queue.shift();
      if (!job) return;
      void job();
    }
  }

  private async generate(sessionId: string, p: Pending): Promise<void> {
    const abort = new AbortController();
    this.running.add(abort);
    let timer: unknown;
    try {
      const { db } = this.deps;
      if (!this.deps.enabled() || db.metaOf(sessionId).customTitle) return;
      const run = this.deps.run();
      if (!run) {
        this.deps.debug?.(`title of ${sessionId}: skipped, Claude Code cannot run now`);
        return;
      }
      const prompt = titlePrompt(p.text, this.deps.firstReply(sessionId));
      if (!prompt) return;
      const timeoutMs = this.deps.timeoutMs ?? TITLE_TIMEOUT_MS;
      // The timeout and a shutdown abort the query and settle this at once.
      const stopped = new Promise<never>((_, reject) => {
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
      });
      timer = this.timers.setTimeout(
        () => abort.abort(new Error(`timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      const answer = await Promise.race([
        this.deps.adapter.oneShot({
          prompt,
          systemPrompt: TITLE_SYSTEM_PROMPT,
          model: TITLE_MODEL,
          cwd: p.cwd,
          env: run.env,
          claudePath: run.claudePath,
          signal: abort.signal,
        }),
        stopped,
      ]);
      if (abort.signal.aborted) return; // shut down meanwhile
      const title = sanitizeTitle(answer);
      if (!title) throw new Error('the answer held no usable title');
      db.setGeneratedTitle(sessionId, title);
      this.deps.titleChanged(sessionId);
      this.deps.emit({ event: 'sessions.changed', data: { sessionIds: [sessionId] } });
    } catch (err) {
      this.deps.debug?.(`title of ${sessionId}: ${errorText(err)}`);
    } finally {
      if (timer !== undefined) this.timers.clearTimeout(timer);
      this.running.delete(abort);
      this.pump();
    }
  }
}
