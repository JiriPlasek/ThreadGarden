import type { ChatItem, TimelineActivity } from '@threadgarden/protocol';

/** An observed message time/range, not an inferred thinking/API-wait interval. */
export type TimelineObservation = {
  firstAt: number;
  lastAt: number;
  sourceId: string;
  minutes?: ReadonlySet<number>;
  knownInterval?: { from: number; to: number };
};
const known = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0;
const MINUTE = 60000;

/** Four bit channels per bucket: tool pending, reasoning, user prompt, assistant reply. */
export const timelineActivity = (
  items: readonly ChatItem[],
  times: ReadonlyMap<string, TimelineObservation>,
  startedAt: number | undefined,
  endedAt: number | undefined,
  now?: number,
): TimelineActivity | undefined => {
  if (!known(startedAt)) return undefined;
  const lastObserved = items.reduce((last, item) => {
    const at =
      item.kind === 'user'
        ? item.ts
        : item.kind === 'toolCall'
          ? (item.endedAt ?? item.startedAt)
          : times.get(item.id)?.lastAt;
    return known(at) ? Math.max(last, at) : last;
  }, startedAt);
  const end = Math.max(startedAt, known(endedAt) ? endedAt : known(now) ? now : lastObserved);
  const duration = end - startedAt;
  const binMs = Math.max(MINUTE, Math.ceil(duration / (1440 * MINUTE)) * MINUTE);
  const count = Math.min(1440, Math.max(1, Math.ceil(duration / binMs)));
  const bins = new Uint8Array(count);
  const toolEdges = new Int32Array(count + 1);
  const prompts = new Set<string>();
  const replies = new Set<string>();
  const reasoning = new Set<string>();
  let toolCalls = 0;
  let longestTool: TimelineActivity['longestTool'];
  const index = (at: number): number =>
    Math.min(count - 1, Math.max(0, Math.floor((at - startedAt) / binMs)));
  const mark = (from: number, to: number, flag: number): void => {
    if (to < startedAt || from > end) return;
    const first = index(from);
    const last = index(Math.max(from, to - 1));
    if (flag === 1) {
      toolEdges[first] = toolEdges[first]! + 1;
      toolEdges[last + 1] = toolEdges[last + 1]! - 1;
    } else for (let i = first; i <= last; i++) bins[i]! |= flag;
  };
  for (const item of items) {
    if (item.kind === 'toolCall' && known(item.startedAt)) {
      const finish = known(item.endedAt)
        ? item.endedAt
        : item.status === 'running' && known(now)
          ? end
          : item.startedAt;
      if (finish < item.startedAt || finish < startedAt || item.startedAt > end) continue;
      toolCalls++;
      const durationMs = Math.max(0, Math.min(end, finish) - Math.max(startedAt, item.startedAt));
      if (
        (known(item.endedAt) || known(now)) &&
        (!longestTool || durationMs > longestTool.durationMs)
      )
        longestTool = { name: item.name, durationMs };
      mark(item.startedAt, finish, 1);
    } else if (item.kind === 'user' && known(item.ts)) {
      if (item.ts < startedAt || item.ts > end) continue;
      prompts.add(item.id);
      mark(item.ts, item.ts, 4);
    } else if (item.kind === 'thinking' || item.kind === 'assistantText') {
      const observation = times.get(item.id);
      if (
        !observation ||
        (observation.knownInterval?.to ?? observation.lastAt) < startedAt ||
        (observation.knownInterval?.from ?? observation.firstAt) > end
      )
        continue;
      if (item.kind === 'thinking') reasoning.add(item.id);
      else replies.add(observation.sourceId);
      // A stream's first/last token do not prove it was generating throughout
      // the gap. Mark only minutes in which a message/chunk was observed.
      if (observation.knownInterval)
        mark(
          observation.knownInterval.from,
          observation.knownInterval.to,
          item.kind === 'thinking' ? 2 : 8,
        );
      else {
        const moments = observation.minutes ?? new Set([observation.firstAt, observation.lastAt]);
        for (const moment of moments) {
          const at = Math.max(observation.firstAt, moment);
          mark(at, at, item.kind === 'thinking' ? 2 : 8);
        }
      }
    }
  }
  let tools = 0;
  for (let i = 0; i < count; i++) {
    tools += toolEdges[i]!;
    if (tools > 0) bins[i]! |= 1;
  }
  if (!toolCalls && !prompts.size && !replies.size && !reasoning.size) return undefined;
  return {
    startedAt,
    endedAt: end,
    binMs,
    bins: [...bins].map((b) => b.toString(16)).join(''),
    prompts: prompts.size,
    replies: replies.size,
    reasoning: reasoning.size,
    toolCalls,
    ...(longestTool ? { longestTool } : {}),
  };
};
