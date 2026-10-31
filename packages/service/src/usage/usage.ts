/**
 * The account's plan usage (v1.3 B, spec §3). Sources, never scraped:
 * - `rate_limit_event`s streamed by every live session (`windowsFromEvent`);
 * - on demand, the SDK's experimental usage reading of a running session
 *   (`readingFromUsage`), at most once a minute, never by starting a process.
 *
 * Both are parsed leniently: unknown fields are ignored, missing ones
 * tolerated, and a reading that does not look like one is dropped. The latest
 * value per window is kept account-wide (every chat is the same account) and
 * persisted in `pahub.db` (`usage_limits`). The tracker also remembers which
 * chats a limit refused, until one of their later turns goes through.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  UsageWindowSchema,
  type RefusedChat,
  type UsageState,
  type UsageWindow,
} from '@pahub/protocol';
import type { Timers } from '../chat/live-session.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Below this a number is taken as seconds since the epoch (it is the year 5138 in seconds). */
const SECONDS_BELOW = 1e11;

/**
 * A reset time as epoch ms. The SDK types `resetsAt` as a bare number without
 * a unit; Claude Code 2.1.314 fills it in seconds (from the
 * `anthropic-ratelimit-unified-*-reset` headers), and the usage reading uses
 * ISO strings. Seconds, milliseconds, numeric strings and ISO dates are all
 * accepted, in case that changes.
 */
export const toEpochMs = (v: unknown): number | undefined => {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return undefined;
    if (/^\d+(\.\d+)?$/.test(t)) return toEpochMs(Number(t));
    const parsed = Date.parse(t);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const n = num(v);
  if (n === undefined || n <= 0) return undefined;
  return Math.round(n < SECONDS_BELOW ? n * 1000 : n);
};

/**
 * Utilization as a percentage. The usage reading reports 0–100; the events'
 * `utilization` is a fraction (Claude Code 2.1.314 keeps it as one and
 * multiplies by 100 for its own usage answer), so it is scaled. Negative
 * values are dropped.
 */
const percent = (v: unknown, fraction: boolean): number | undefined => {
  const n = num(v);
  if (n === undefined || n < 0) return undefined;
  return fraction ? n * 100 : n;
};

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
const status = (v: unknown): UsageWindow['status'] =>
  typeof v === 'string' && STATUSES.has(v) ? (v as UsageWindow['status']) : undefined;

/** The window a rate-limit event without `rateLimitType` reports on. */
export const CURRENT_WINDOW = 'current';

/**
 * The windows one `rate_limit_info` reports: its own (`rateLimitType`), and
 * the overage state when it carries one. Nothing when it is not an object.
 */
export const windowsFromEvent = (info: unknown, now: number): UsageWindow[] => {
  if (!isRec(info)) return [];
  const out: UsageWindow[] = [];
  const key = str(info.rateLimitType) ?? CURRENT_WINDOW;
  const own: UsageWindow = { key, observedAt: now, source: 'event' };
  const s = status(info.status);
  if (s) own.status = s;
  const u = percent(info.utilization, true);
  if (u !== undefined) own.utilization = u;
  const r = toEpochMs(info.resetsAt);
  if (r !== undefined) own.resetsAt = r;
  out.push(own);
  const overage = status(info.overageStatus);
  if (overage && key !== 'overage') {
    const w: UsageWindow = { key: 'overage', observedAt: now, source: 'event', status: overage };
    const or = toEpochMs(info.overageResetsAt);
    if (or !== undefined) w.resetsAt = or;
    out.push(w);
  }
  return out;
};

/**
 * Whether a `rate_limit_info` refuses the turn it arrived in: the limit is
 * `rejected` and overage does not carry the request instead.
 */
export const refusesTurn = (info: unknown): boolean => {
  if (!isRec(info) || info.status !== 'rejected') return false;
  return info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning';
};

export type UsageReading = {
  windows: UsageWindow[];
  subscriptionType?: string;
  rateLimitsAvailable?: boolean;
};

/**
 * The SDK's experimental usage answer (`SDKControlGetUsageResponse`) as
 * windows; undefined when it does not look like one (no `rate_limits` and no
 * `rate_limits_available`). Windows that are null or carry neither a
 * utilization nor a reset time are left out.
 */
export const readingFromUsage = (resp: unknown, now: number): UsageReading | undefined => {
  if (!isRec(resp)) return undefined;
  const available = bool(resp.rate_limits_available);
  const limits = isRec(resp.rate_limits) ? resp.rate_limits : undefined;
  if (available === undefined && !limits) return undefined;
  const reading: UsageReading = { windows: [] };
  if (available !== undefined) reading.rateLimitsAvailable = available;
  const plan = str(resp.subscription_type);
  if (plan) reading.subscriptionType = plan;
  const windowOf = (key: string, v: unknown, label?: string): UsageWindow | undefined => {
    if (!isRec(v)) return undefined;
    const u = percent(v.utilization, false);
    const r = toEpochMs(v.resets_at);
    if (u === undefined && r === undefined) return undefined;
    const w: UsageWindow = { key, observedAt: now, source: 'usage' };
    if (label) w.label = label;
    if (u !== undefined) w.utilization = u;
    if (r !== undefined) w.resetsAt = r;
    return w;
  };
  for (const [key, v] of Object.entries(limits ?? {})) {
    if (key === 'model_scoped') {
      for (const m of Array.isArray(v) ? v : []) {
        const label = isRec(m) ? str(m.display_name) : undefined;
        const w = label ? windowOf(`model:${label}`, m, label) : undefined;
        if (w) reading.windows.push(w);
      }
    } else if (key === 'extra_usage') {
      if (!isRec(v)) continue;
      const enabled = bool(v.is_enabled);
      const u = percent(v.utilization, false);
      if (enabled !== true && u === undefined) continue;
      const credits: NonNullable<UsageWindow['credits']> = {};
      if (enabled !== undefined) credits.enabled = enabled;
      const used = num(v.used_credits);
      if (used !== undefined) credits.used = used;
      const limit = num(v.monthly_limit);
      if (limit !== undefined) credits.limit = limit;
      const currency = str(v.currency);
      if (currency) credits.currency = currency;
      const w: UsageWindow = { key, observedAt: now, source: 'usage', credits };
      if (u !== undefined) w.utilization = u;
      reading.windows.push(w);
    } else {
      const w = windowOf(key, v);
      if (w) reading.windows.push(w);
    }
  }
  return reading;
};

/** Reset times this close are the same window (events round to seconds, readings may not). */
const SAME_RESET_MS = 60_000;

/**
 * Folds a newer observation of a window into the known one. A reading
 * without a status keeps the event's status while the window's reset time is
 * the same (a reset starts a new window, whose status is not known yet).
 */
export const mergeWindow = (prev: UsageWindow | undefined, next: UsageWindow): UsageWindow => {
  if (!prev || next.status !== undefined) return { ...prev, ...next };
  const merged: UsageWindow = { ...prev, ...next };
  const sameWindow =
    prev.resetsAt === undefined ||
    next.resetsAt === undefined ||
    Math.abs(prev.resetsAt - next.resetsAt) < SAME_RESET_MS;
  if (!sameWindow) delete merged.status;
  return merged;
};

/** The parts of a window the user sees (a newer `observedAt` alone is no change). */
const sameView = (a: UsageWindow | undefined, b: UsageWindow): boolean =>
  !!a &&
  a.status === b.status &&
  a.utilization === b.utilization &&
  a.resetsAt === b.resetsAt &&
  a.label === b.label &&
  JSON.stringify(a.credits) === JSON.stringify(b.credits);

/** `usage_limits` row of the account-level fields. */
const ACCOUNT_KEY = '@account';

/** How often the experimental reading may be asked for. */
export const USAGE_READ_INTERVAL_MS = 60_000;
/** How long a reading may take before it counts as failed. */
export const USAGE_READ_TIMEOUT_MS = 10_000;

export type UsageTrackerDeps = {
  /** `pahub.db` (the `usage_limits` table); without it nothing is persisted. */
  raw?: DatabaseSync;
  now: () => number;
  /** The state changed (the `usage.changed` event). */
  emit: (state: UsageState) => void;
  timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>;
  /** A contained failure; also where failed usage readings are logged. */
  onError: (err: unknown, context: string) => void;
};

type Account = { subscriptionType?: string; rateLimitsAvailable?: boolean };

export class UsageTracker {
  private readonly windows = new Map<string, UsageWindow>();
  private account: Account = {};
  private readonly refused = new Map<string, RefusedChat>();
  /** Chats a limit refused during the turn now running (decided at its result). */
  private readonly refusedThisTurn = new Set<string>();
  private lastRead = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;

  constructor(private readonly deps: UsageTrackerDeps) {
    this.load();
  }

  /** What the UI shows. A refusal without a reset time of its own gets the account's. */
  state(): UsageState {
    const reset = this.limitResetAt();
    return {
      windows: [...this.windows.values()].sort((a, b) => a.key.localeCompare(b.key)),
      ...(this.account.subscriptionType === undefined
        ? {}
        : { subscriptionType: this.account.subscriptionType }),
      ...(this.account.rateLimitsAvailable === undefined
        ? {}
        : { rateLimitsAvailable: this.account.rateLimitsAvailable }),
      refused: [...this.refused.values()].map((r) =>
        r.resetsAt === undefined && reset !== undefined ? { ...r, resetsAt: reset } : r,
      ),
    };
  }

  /**
   * When the limit that refuses requests now resets: the latest reset among
   * the rejected windows whose reset is still ahead. Undefined when no window
   * is known to be rejected (or none says when it resets).
   */
  limitResetAt(): number | undefined {
    const now = this.deps.now();
    let latest: number | undefined;
    for (const w of this.windows.values()) {
      if (w.status !== 'rejected' || w.resetsAt === undefined || w.resetsAt <= now) continue;
      if (latest === undefined || w.resetsAt > latest) latest = w.resetsAt;
    }
    return latest;
  }

  /** A `rate_limit_event` of `sessionId`. */
  observeEvent(sessionId: string, info: unknown): void {
    const now = this.deps.now();
    let changed = false;
    for (const w of windowsFromEvent(info, now)) changed = this.put(w) || changed;
    if (refusesTurn(info)) changed = this.markRefused(sessionId, now) || changed;
    if (changed) this.publish();
  }

  /** An assistant message of `sessionId` carried the API error `rate_limit`. */
  noteRefusal(sessionId: string): void {
    if (this.markRefused(sessionId, this.deps.now())) this.publish();
  }

  /**
   * A turn of `sessionId` ended (its `result`); true when a usage limit
   * refused it. A turn that went through clears the chat's limit notice.
   */
  turnEnded(sessionId: string): boolean {
    const refused = this.refusedThisTurn.delete(sessionId);
    if (!refused && this.refused.delete(sessionId)) this.publish();
    return refused;
  }

  /** Whether a usage limit refused the last turn of `sessionId`. */
  isRefused(sessionId: string): boolean {
    return this.refused.has(sessionId);
  }

  /**
   * Asks a running session for a fresh usage reading: at most once every
   * `USAGE_READ_INTERVAL_MS` and only when `read` exists (a live session that
   * supports it). A failure, a timeout or an answer of another shape is
   * logged and changes nothing. Concurrent calls share one reading.
   */
  refresh(read: (() => Promise<unknown>) | undefined): Promise<void> {
    if (this.reading) return this.reading;
    const now = this.deps.now();
    if (!read || now - this.lastRead < USAGE_READ_INTERVAL_MS) return Promise.resolve();
    this.lastRead = now;
    this.reading = this.readOnce(read).finally(() => (this.reading = null));
    return this.reading;
  }

  private async readOnce(read: () => Promise<unknown>): Promise<void> {
    const { timers } = this.deps;
    let timer: unknown;
    const timeout = new Promise<never>((_, reject) => {
      timer = timers.setTimeout(
        () => reject(new Error('the usage reading timed out')),
        USAGE_READ_TIMEOUT_MS,
      );
    });
    let resp: unknown;
    try {
      resp = await Promise.race([read(), timeout]);
    } catch (err) {
      this.deps.onError(new Error(`usage reading failed: ${errorText(err)}`), 'usage');
      return;
    } finally {
      timers.clearTimeout(timer);
    }
    const reading = readingFromUsage(resp, this.deps.now());
    if (!reading) {
      this.deps.onError(new Error('usage reading had an unexpected shape'), 'usage');
      return;
    }
    let changed = false;
    for (const w of reading.windows) changed = this.put(w) || changed;
    const account: Account = { ...this.account };
    if (reading.subscriptionType !== undefined) account.subscriptionType = reading.subscriptionType;
    if (reading.rateLimitsAvailable !== undefined) {
      account.rateLimitsAvailable = reading.rateLimitsAvailable;
    }
    if (
      account.subscriptionType !== this.account.subscriptionType ||
      account.rateLimitsAvailable !== this.account.rateLimitsAvailable
    ) {
      this.account = account;
      this.store(ACCOUNT_KEY, account);
      changed = true;
    }
    if (changed) this.publish();
  }

  private markRefused(sessionId: string, now: number): boolean {
    this.refusedThisTurn.add(sessionId);
    const known = this.refused.get(sessionId);
    if (known) return false;
    this.refused.set(sessionId, { sessionId, at: now });
    return true;
  }

  /** Stores a window (always: its observed time moves on); true when what the UI shows changed. */
  private put(w: UsageWindow): boolean {
    const prev = this.windows.get(w.key);
    const next = mergeWindow(prev, w);
    this.windows.set(w.key, next);
    this.store(w.key, next);
    return !sameView(prev, next);
  }

  private store(key: string, value: unknown): void {
    const raw = this.deps.raw;
    if (!raw) return;
    try {
      raw
        .prepare(
          `INSERT INTO usage_limits (key, json, observed_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET json = excluded.json, observed_at = excluded.observed_at`,
        )
        .run(key, JSON.stringify(value), this.deps.now());
    } catch (err) {
      this.deps.onError(err, 'usage store');
    }
  }

  private load(): void {
    const raw = this.deps.raw;
    if (!raw) return;
    try {
      for (const r of raw.prepare('SELECT key, json FROM usage_limits').all()) {
        let value: unknown;
        try {
          value = JSON.parse(r.json as string);
        } catch {
          continue; // a corrupt row is forgotten
        }
        if (r.key === ACCOUNT_KEY) {
          if (!isRec(value)) continue;
          const plan = str(value.subscriptionType);
          const available = bool(value.rateLimitsAvailable);
          this.account = {
            ...(plan ? { subscriptionType: plan } : {}),
            ...(available === undefined ? {} : { rateLimitsAvailable: available }),
          };
          continue;
        }
        const w = UsageWindowSchema.safeParse(value);
        if (w.success) this.windows.set(w.data.key, w.data);
      }
    } catch (err) {
      this.deps.onError(err, 'usage load');
    }
  }

  private publish(): void {
    try {
      this.deps.emit(this.state());
    } catch (err) {
      this.deps.onError(err, 'usage.changed');
    }
  }
}
