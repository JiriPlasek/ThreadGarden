/**
 * Timers a Claude Code process holds in memory: a `/loop` wake-up
 * (`ScheduleWakeup`) and scheduled prompts (`CronCreate`). They fire only while
 * that process runs, so a chat holding one must not be closed between turns
 * (idle reclaim, a restart for MCP changes) and keeps its machine awake.
 *
 * Read from the stream: the assistant's `tool_use` blocks give the tool's name,
 * and the user message answering one carries the tool's structured output in
 * `tool_use_result` (`ScheduleWakeupOutput`, `CronCreateOutput`,
 * `CronDeleteOutput` in the SDK's tool types).
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** A wake-up counts this long after its time: it can fire late, e.g. right after a turn. */
export const WAKE_GRACE_MS = 5 * 60_000;
/** Claude Code ends a recurring job after 7 days. */
export const CRON_MAX_MS = 7 * 24 * 60 * 60_000;
/** `ScheduleWakeup` clamps its delay to [60, 3600] seconds. */
const WAKE_MIN_S = 60;
const WAKE_MAX_S = 3600;

const TOOLS = new Set(['ScheduleWakeup', 'CronCreate', 'CronDelete']);

type Job = { until: number };

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

export class ScheduleTracker {
  /** Open `tool_use` ids of the tools above, by id. */
  private readonly calls = new Map<string, string>();
  private wakeAt: number | null = null;
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly now: () => number) {}

  /** Reads one stream message. */
  apply(m: SDKMessage): void {
    const x: unknown = m;
    if (!isRec(x) || !isRec(x.message)) return;
    const content = x.message.content;
    if (!Array.isArray(content)) return;
    if (x.type === 'assistant') {
      for (const b of content) {
        if (!isRec(b) || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
        if (typeof b.name !== 'string' || !TOOLS.has(b.name)) continue;
        this.calls.set(b.id, b.name);
        if (b.name === 'ScheduleWakeup') this.wakeCalled(b.input);
      }
    } else if (x.type === 'user') {
      for (const b of content) {
        if (!isRec(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        const name = this.calls.get(b.tool_use_id);
        if (name === undefined) continue;
        this.calls.delete(b.tool_use_id);
        if (b.is_error === true) continue;
        this.answered(name, x.tool_use_result);
      }
    }
  }

  /** A timer is waiting to fire in this process. */
  get pending(): boolean {
    const now = this.now();
    if (this.wakeAt !== null && now >= this.wakeAt + WAKE_GRACE_MS) this.wakeAt = null;
    for (const [id, j] of this.jobs) if (now >= j.until) this.jobs.delete(id);
    return this.wakeAt !== null || this.jobs.size > 0;
  }

  /** The process is gone: its timers went with it. */
  clear(): void {
    this.calls.clear();
    this.wakeAt = null;
    this.jobs.clear();
  }

  /** From the call itself, in case the output carries no time. */
  private wakeCalled(input: unknown): void {
    if (!isRec(input)) return;
    if (input.stop === true) {
      this.wakeAt = null;
      return;
    }
    const delay = num(input.delaySeconds);
    if (delay === undefined) return;
    const s = Math.min(WAKE_MAX_S, Math.max(WAKE_MIN_S, delay));
    this.wakeAt = this.now() + s * 1000;
  }

  private answered(name: string, out: unknown): void {
    if (!isRec(out)) return;
    if (name === 'ScheduleWakeup') {
      if (out.stopped === true) this.wakeAt = null;
      else {
        const at = num(out.scheduledFor);
        if (at !== undefined) this.wakeAt = at;
      }
    } else if (name === 'CronCreate') {
      if (typeof out.id !== 'string') return;
      const now = this.now();
      const next = num(out.nextFireAt);
      // A one-shot job ends when it fires; a recurring one when deleted or after 7 days.
      const until =
        out.recurring === false && next !== undefined ? next + WAKE_GRACE_MS : now + CRON_MAX_MS;
      this.jobs.set(out.id, { until });
    } else if (name === 'CronDelete') {
      if (typeof out.id === 'string') this.jobs.delete(out.id);
    }
  }
}
