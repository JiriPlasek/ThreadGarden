/**
 * v1.3 B: one machine's plan usage (spec §3) — what the bottom strip's chips
 * and the Usage dialog show (grouped by account in `usage-accounts`), and
 * which chats a usage limit refused (their limit notice and "Send when the
 * limit resets"). The machine's service keeps the state; this mirrors it
 * (`usage.get`, then every `usage.changed`). Every machine scope has one.
 *
 * Time matters here: a refusal ends at its reset, so `now` moves on by itself
 * at the next known reset time (one timer, no polling).
 */
import {
  usageEmpty,
  UsageStateSchema,
  type RefusedChat,
  type UsageState,
  type UsageWindow,
} from '@threadgarden/protocol';
import { quietly, type Api } from './api';

/** The window the meter shows: the 5-hour one, else an event's window of unknown type. */
const METER_KEYS = ['five_hour', 'current'];

/** Display names of the windows the SDK reports; others show their key. */
const LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  current: 'Current limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly limit · Opus',
  seven_day_sonnet: 'Weekly limit · Sonnet',
  seven_day_oauth_apps: 'Weekly limit · connected apps',
  seven_day_overage_included: 'Weekly limit · overage included',
  overage: 'Overage',
  extra_usage: 'Extra usage',
};

/** The Usage dialog's order: the 5-hour window first, then weekly, then the rest. */
const ORDER = [
  'five_hour',
  'current',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
  'seven_day_overage_included',
];

export const windowLabel = (w: Pick<UsageWindow, 'key' | 'label'>): string =>
  w.key.startsWith('codex:')
    ? (w.label ?? w.key)
    : (LABELS[w.key] ??
      (w.key.startsWith('model:') ? `Weekly limit · ${w.label ?? w.key.slice(6)}` : w.key));

/** A window's status now: a rejection or warning lapses once its window has reset. */
export const windowStatus = (w: UsageWindow, now: number): UsageWindow['status'] =>
  w.resetsAt !== undefined && w.resetsAt <= now ? undefined : w.status;

/** Windows in the dialog's order. */
export const sortWindows = (ws: readonly UsageWindow[]): UsageWindow[] => {
  const rank = (k: string): number => {
    const i = ORDER.indexOf(k);
    if (i >= 0) return i;
    if (k.startsWith('model:')) return ORDER.length;
    return ORDER.length + 1;
  };
  return [...ws].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
};

/** `localStorage` key of a paired machine's last usage state. */
const rememberKey = (machineId: string): string => `threadgarden.usage.${machineId}`;

const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);

/** The usage state kept for `machineId`, if any (a broken copy reads as none). */
const recall = (machineId: string): UsageState | undefined => {
  try {
    const raw = storage()?.getItem(rememberKey(machineId));
    if (!raw) return undefined;
    const parsed = UsageStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export class UsageStore {
  value = $state.raw<UsageState>(usageEmpty);
  /** Its service answers now; otherwise `value` is the last state it sent. */
  connected = $state(false);
  /** Moves on at the next known reset, so refusals and warnings lapse on time. */
  now = $state(Date.now());

  private api: Api | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every state that arrives: an answer overtaken by a newer state is dropped. */
  private version = 0;
  /** A paired machine's id: its last state is kept, so an off machine still shows it. */
  private readonly remember: string | undefined;
  /** Its scope is gone: no timer runs and nothing more is kept. */
  private stopped = false;

  constructor(opts: { remember?: string } = {}) {
    this.remember = opts.remember;
    const kept = opts.remember === undefined ? undefined : recall(opts.remember);
    if (!kept) return;
    this.value = kept;
    this.wake();
  }

  /** The meter's window, when known. */
  meter = $derived.by((): UsageWindow | undefined => {
    for (const key of METER_KEYS) {
      const w = this.value.windows.find((x) => x.key === key);
      if (w) return w;
    }
    return undefined;
  });

  /**
   * When the limit that refuses requests now resets: the latest reset among
   * the rejected windows still ahead.
   */
  limitResetAt = $derived.by((): number | undefined => {
    let latest: number | undefined;
    for (const w of this.value.windows) {
      if (w.status !== 'rejected' || w.resetsAt === undefined || w.resetsAt <= this.now) continue;
      if (latest === undefined || w.resetsAt > latest) latest = w.resetsAt;
    }
    return latest;
  });

  init = (api: Api): void => {
    this.api = api;
    this.connected = api.status === 'open';
    api.onStatus((s) => (this.connected = s === 'open'));
    api.on('usage.changed', (state) => this.set(state));
    api.onOpen(() => this.load());
    if (api.status === 'open') quietly(this.load());
  };

  /**
   * The chat's refusal by a usage limit, while it holds: until a later turn
   * goes through (the service clears it) or the limit has reset.
   */
  refusal = (sessionId: string): RefusedChat | undefined => {
    const state = sessionId.startsWith('codex-')
      ? (this.value.providers?.codex ?? usageEmpty)
      : this.value;
    const r = state.refused.find((x) => x.sessionId === sessionId);
    if (!r) return undefined;
    return r.resetsAt !== undefined && r.resetsAt <= this.now ? undefined : r;
  };

  limitResetAtFor = (sessionId: string): number | undefined => {
    const state = sessionId.startsWith('codex-')
      ? (this.value.providers?.codex ?? usageEmpty)
      : this.value;
    const times = state.windows
      .filter((w) => w.status === 'rejected' && w.resetsAt !== undefined && w.resetsAt > this.now)
      .map((w) => w.resetsAt!);
    return times.length ? Math.max(...times) : undefined;
  };

  /** Asks a running chat on the machine for a fresh reading. */
  refresh = async (): Promise<void> => {
    const api = this.api;
    if (!api) return;
    // The service's state after the reading: as new as any event before it.
    this.set(await api.request('usage.get', { refresh: true }));
  };

  /** Its scope is gone: stops the reset timer and keeps no later state. */
  stop = (): void => {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  };

  /** Its machine was removed: stops, and removes the kept copy (a re-pairing starts empty). */
  forget = (): void => {
    this.stop();
    if (this.remember === undefined) return;
    try {
      storage()?.removeItem(rememberKey(this.remember));
    } catch {
      // Storage unavailable: nothing was kept either.
    }
  };

  private load = async (): Promise<void> => {
    if (!this.api) return;
    const asked = this.version;
    const state = await this.api.request('usage.get', {});
    if (this.version === asked) this.set(state);
  };

  private set = (state: UsageState): void => {
    this.version++;
    this.value = state;
    this.now = Date.now();
    this.wake();
    if (this.remember !== undefined && !this.stopped) {
      try {
        storage()?.setItem(rememberKey(this.remember), JSON.stringify(state));
      } catch {
        // Not kept (storage full or unavailable): the machine shows it while it is on.
      }
    }
  };

  /** One timer for the next reset ahead (refusal or window), capped at a day. */
  private wake = (): void => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    const now = Date.now();
    const times = [
      ...this.value.windows.map((w) => w.resetsAt),
      ...this.value.refused.map((r) => r.resetsAt),
      ...Object.values(this.value.providers ?? {}).flatMap((state) => [
        ...state.windows.map((w) => w.resetsAt),
        ...state.refused.map((r) => r.resetsAt),
      ]),
    ].filter((t): t is number => t !== undefined && t > now);
    if (times.length === 0) return;
    const delay = Math.min(Math.min(...times) - now + 1_000, 24 * 3_600_000);
    this.timer = setTimeout(() => {
      this.now = Date.now();
      this.wake();
    }, delay);
  };
}

/** This PC's (its scope's `usage`; paired machines' scopes have their own). */
export const usage = new UsageStore();
