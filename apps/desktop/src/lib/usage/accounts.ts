/**
 * Usage per account (usage-per-account design §4): every machine's usage
 * state, grouped by the account it is signed in to. Machines on the same
 * claude.ai login (by email) share one entry; a machine whose account is not
 * known, or is an API key or a provider, is an entry of its own (readings are
 * never guessed onto an account).
 */
import type { UsageAccount, UsageState, UsageWindow } from '@threadgarden/protocol';

/** One machine's usage as the desktop knows it. */
export type UsageMachine = {
  machineId: string;
  /** How the UI names it ("This PC", or the paired machine's name). */
  name: string;
  state: UsageState;
  /** Its service answers now; otherwise `state` is the last one it sent. */
  connected: boolean;
};

/** One account and the machines signed in to it. */
export type UsageEntry = {
  /** `email:<lowercase email>`, or `machine:<id>` for an unknown account, an API key or a provider. */
  key: string;
  account: UsageAccount | undefined;
  machines: UsageMachine[];
  /** Per window key, the newest reading (`observedAt`) among the machines. */
  windows: UsageWindow[];
  /** Every machine of the entry is disconnected: when its newest reading was seen. */
  asOf: number | undefined;
};

const keyOf = (m: UsageMachine): string => {
  const a = m.state.account;
  const email = a?.kind === 'login' ? a.email?.trim().toLowerCase() : undefined;
  return email ? `email:${email}` : `machine:${m.machineId}`;
};

/** Newest reading per window key, in the order the keys first appear. */
const newestWindows = (machines: UsageMachine[]): UsageWindow[] => {
  const byKey = new Map<string, UsageWindow>();
  for (const m of machines) {
    for (const w of m.state.windows) {
      const old = byKey.get(w.key);
      if (!old || w.observedAt > old.observedAt) byKey.set(w.key, w);
    }
  }
  return [...byKey.values()];
};

/**
 * The account entries of `machines` (This PC first, then the places column's
 * order); each entry sits where its first machine does.
 */
export const groupUsage = (machines: UsageMachine[]): UsageEntry[] => {
  const groups = new Map<string, UsageMachine[]>();
  for (const m of machines) {
    const key = keyOf(m);
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }
  return [...groups].map(([key, ms]) => {
    const windows = newestWindows(ms);
    const offline = ms.every((m) => !m.connected);
    return {
      key,
      account: ms[0]!.state.account,
      machines: ms,
      windows,
      asOf:
        offline && windows.length > 0 ? Math.max(...windows.map((w) => w.observedAt)) : undefined,
    };
  });
};

/** The 5-hour window: the SDK's, else an event's window of unknown type. */
const FIVE_HOUR = ['five_hour', 'current'];
/** Per-model weekly windows the SDK names itself (after the `model:*` ones). */
const MODEL_WEEKLY = ['seven_day_opus', 'seven_day_sonnet'];

/** What an account's chip shows: 5h, Week, then the per-model weekly windows. */
export const chipWindows = (e: UsageEntry): UsageWindow[] => {
  const find = (key: string): UsageWindow | undefined => e.windows.find((w) => w.key === key);
  const fiveHour = FIVE_HOUR.map(find).find((w) => w !== undefined);
  return [
    fiveHour,
    find('seven_day'),
    ...e.windows.filter((w) => w.key.startsWith('model:')),
    ...MODEL_WEEKLY.map(find),
  ].filter((w): w is UsageWindow => w !== undefined);
};
