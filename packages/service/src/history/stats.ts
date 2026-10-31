/**
 * v1.3 analytics (design §4): per-session statistics, extracted from the
 * messages the indexer already reads through the SDK's `getSessionMessages`
 * (never from transcript files). Every shape is read leniently: a field that
 * is missing or of another type counts as absent, never as an error.
 */
import type { SessionMessage } from '../sdk/adapter.js';

/**
 * Bumped when the extraction changes: sessions with statistics of an older
 * version are gathered again by the background backfill.
 */
export const STATS_VERSION = 1;

export type DayModelStats = {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** The assistant's model; `''` on the rows that count user messages. */
  model: string;
  userMessages: number;
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type SessionStats = {
  firstAt: number | null;
  lastAt: number | null;
  days: DayModelStats[];
  /** Messages (user and assistant, main conversation) per local day and hour. */
  hours: { day: string; hour: number; messages: number }[];
  tools: { day: string; name: string; calls: number }[];
  /** Agent / Task tool calls by `input.subagent_type`. */
  agents: { day: string; type: string; calls: number }[];
};

/** The subagent type Claude Code uses when an Agent call names none. */
export const DEFAULT_SUBAGENT = 'general-purpose';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const UNKNOWN_MODEL = 'unknown';
/** Claude Code's model name on replies it made up itself (errors, interruptions). */
const SYNTHETIC_MODEL = '<synthetic>';
/**
 * CLI envelopes the user typed (a slash command, a `!` command); every other
 * message that is one XML-like envelope is something the CLI injected.
 */
const TYPED_ENVELOPES = new Set(['command-message', 'command-name', 'bash-input']);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const tokens = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day of `t` (the machine the service runs on). */
export const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const timeOf = (m: Rec): number | undefined => {
  const v = m.timestamp;
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** Text of a user message that is a single XML-like envelope: its tag, else undefined. */
const envelopeTag = (text: string): string | undefined => {
  const t = text.trim();
  // Cheap test first: a long prompt is never scanned by the expression.
  if (!t.startsWith('<') || !t.endsWith('>')) return undefined;
  const open = /^<([a-z][\w-]*)>/i.exec(t)?.[1];
  return open !== undefined && /<\/[a-z][\w-]*>$/i.test(t) ? open : undefined;
};

/** A message the user wrote (text or images), not a tool result or something the CLI wrote. */
const isUserPrompt = (m: Rec, msg: Rec): boolean => {
  if (m.isMeta === true || m.isCompactSummary === true || m.isSynthetic === true) return false;
  if (m.isSidechain === true || (m.parent_tool_use_id ?? null) !== null) return false;
  const content = msg.content;
  const texts: string[] = [];
  let images = false;
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const b of content as unknown[]) {
      if (!isRec(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image') images = true;
    }
  } else return false;
  if (images) return true;
  const text = texts.join('\n');
  if (text.trim() === '') return false;
  const tag = envelopeTag(text);
  return tag === undefined || TYPED_ENVELOPES.has(tag);
};

type Reply = {
  day: string;
  model: string;
  /** Counted as a message (main conversation), not only for its tokens. */
  main: boolean;
  usage: Rec | undefined;
};

/**
 * Accumulates one session's statistics over its messages, given in order, in
 * as many `add` calls (slices) as the caller likes.
 */
export class StatsCollector {
  private lastTime: number | undefined;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  private readonly userDays = new Map<string, number>();
  /** API replies by message id (entries without an id get their own key). */
  private readonly replies = new Map<string, Reply>();
  private readonly hours = new Map<string, number>();
  private readonly tools = new Map<string, number>();
  private readonly agents = new Map<string, number>();
  private readonly toolIds = new Set<string>();
  private anonymous = 0;

  /** `fallbackTime` places messages without a timestamp before any message has one. */
  constructor(private readonly fallbackTime: number) {}

  add(messages: readonly SessionMessage[]): void {
    for (const m of messages) {
      const r = m as unknown as Rec;
      const msg = r.message;
      if (!isRec(msg)) continue;
      if (r.type === 'user') {
        if (!isUserPrompt(r, msg)) continue;
        const t = this.time(r);
        const day = this.dayOf(t);
        this.userDays.set(day, (this.userDays.get(day) ?? 0) + 1);
        this.hour(day, t);
      } else if (r.type === 'assistant') {
        this.reply(r, msg);
      }
    }
  }

  result(): SessionStats {
    const days = new Map<string, DayModelStats>();
    const row = (day: string, model: string): DayModelStats => {
      const key = `${day}\u0000${model}`;
      let d = days.get(key);
      if (!d) {
        d = {
          day,
          model,
          userMessages: 0,
          assistantMessages: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
        days.set(key, d);
      }
      return d;
    };
    for (const [day, n] of this.userDays) row(day, '').userMessages += n;
    for (const reply of this.replies.values()) {
      const d = row(reply.day, reply.model);
      if (reply.main) d.assistantMessages++;
      const u = reply.usage;
      if (!u) continue;
      d.inputTokens += tokens(u.input_tokens);
      d.outputTokens += tokens(u.output_tokens);
      d.cacheReadTokens += tokens(u.cache_read_input_tokens);
      d.cacheCreationTokens += tokens(u.cache_creation_input_tokens);
    }
    const split = (key: string): [string, string] => {
      const at = key.indexOf('\u0000');
      return [key.slice(0, at), key.slice(at + 1)];
    };
    return {
      firstAt: this.firstAt,
      lastAt: this.lastAt,
      days: [...days.values()],
      hours: [...this.hours].map(([key, messages]) => {
        const [day, hour] = split(key);
        return { day, hour: Number(hour), messages };
      }),
      tools: [...this.tools].map(([key, calls]) => {
        const [day, name] = split(key);
        return { day, name, calls };
      }),
      agents: [...this.agents].map(([key, calls]) => {
        const [day, type] = split(key);
        return { day, type, calls };
      }),
    };
  }

  private reply(r: Rec, msg: Rec): void {
    const rawModel = str(msg.model)?.trim();
    if (rawModel === SYNTHETIC_MODEL) return;
    const t = this.time(r);
    const day = this.dayOf(t);
    const main = r.isSidechain !== true && (r.parent_tool_use_id ?? null) === null;
    const id = str(msg.id);
    const key = id ? `id:${id}` : `anon:${this.anonymous++}`;
    const usage = isRec(msg.usage) ? msg.usage : undefined;
    const known = this.replies.get(key);
    if (known) {
      // A later entry of the same API message carries the more complete usage.
      if (usage) known.usage = usage;
    } else {
      this.replies.set(key, { day, model: rawModel || UNKNOWN_MODEL, main, usage });
      if (main) this.hour(day, t);
    }
    if (!Array.isArray(msg.content)) return;
    for (const b of msg.content as unknown[]) {
      if (!isRec(b) || b.type !== 'tool_use') continue;
      const name = str(b.name)?.trim();
      if (!name) continue;
      const toolId = str(b.id);
      if (toolId) {
        if (this.toolIds.has(toolId)) continue;
        this.toolIds.add(toolId);
      }
      this.bump(this.tools, day, name);
      if (AGENT_TOOLS.has(name)) {
        const input = isRec(b.input) ? b.input : {};
        this.bump(this.agents, day, str(input.subagent_type)?.trim() || DEFAULT_SUBAGENT);
      }
    }
  }

  private bump(map: Map<string, number>, day: string, name: string): void {
    const key = `${day}\u0000${name}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private hour(day: string, t: number): void {
    const key = `${day}\u0000${this.local(t).hour}`;
    this.hours.set(key, (this.hours.get(key) ?? 0) + 1);
  }

  /** The message's time: its timestamp, else the previous message's, else the fallback. */
  private time(r: Rec): number {
    const t = timeOf(r) ?? this.lastTime ?? this.fallbackTime;
    this.lastTime = t;
    if (this.firstAt === null || t < this.firstAt) this.firstAt = t;
    if (this.lastAt === null || t > this.lastAt) this.lastAt = t;
    return t;
  }

  /** The local hour `t` falls in, remembered: consecutive messages mostly share it. */
  private cachedHour = { start: 0, end: -1, day: '', hour: 0 };
  private local(t: number): { day: string; hour: number } {
    const c = this.cachedHour;
    if (t >= c.start && t < c.end) return c;
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    const start = d.getTime();
    this.cachedHour = { start, end: start + 3_600_000, day: localDay(t), hour: d.getHours() };
    return this.cachedHour;
  }

  private dayOf(t: number): string {
    return this.local(t).day;
  }
}
