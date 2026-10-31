/**
 * Ctrl/Cmd+K across machines: every connected machine answers `search.quick`
 * on its own; the answers are merged here the way one service ranks its own.
 */
import type { QuickHit } from './sessions.svelte';

/** A quick-switcher hit and the machine it lives on. */
export type MachineHit = QuickHit & { machineId: string };

/** Places kept for archived matches when they exist (the service's `ARCHIVED_SLOTS`). */
const ARCHIVED_SLOTS = 3;

const byScore = (a: MachineHit, b: MachineHit): number => b.score - a.score;

/**
 * The machines' answers as one: every other match by the service's score,
 * then the archived ones, which keep up to `ARCHIVED_SLOTS` places (at most
 * half the limit) and any the others leave, all cut to `limit`, as one
 * service ranks its own. One machine's answer is kept as it came.
 */
export const mergeQuickHits = (
  lists: readonly { machineId: string; hits: readonly QuickHit[] }[],
  limit: number,
): MachineHit[] => {
  const all = lists.flatMap(({ machineId, hits }) => hits.map((h) => ({ ...h, machineId })));
  if (lists.length === 1) return all;
  // Stable sorts: equal scores keep the machines' order (This PC first).
  const archived = all.filter((h) => h.archived).sort(byScore);
  const kept = Math.min(ARCHIVED_SLOTS, archived.length, Math.floor(limit / 2));
  const main = all
    .filter((h) => !h.archived)
    .sort(byScore)
    .slice(0, limit - kept);
  return [...main, ...archived.slice(0, limit - main.length)];
};
