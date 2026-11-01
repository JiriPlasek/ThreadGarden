import { KeepAwakeSchema, type ChatStatus, type KeepAwake } from '@threadgarden/protocol';

const IN_TURN: ReadonlySet<ChatStatus> = new Set(['working', 'needsYou', 'unknown']);
const OFF: KeepAwake = { mode: 'off', until: null };

export type IdleMonitorOptions = {
  sessions: () => {
    live: boolean;
    status: ChatStatus;
    /** Running background agents; background shells (dev servers, watchers) do not count. */
    runningAgents?: number;
    lastActivity?: number;
  }[];
  /** Same fields as the external poller's sessions (see `externalStatus`). */
  external: () => { status?: string; state?: string }[];
  /** The "Shut down after idle" setting; null is never. */
  minutes: () => number | null;
  now?: () => number;
};

/**
 * Tracks how long a headless machine has had nothing to do (spec §10). Busy is a live
 * chat in a turn, any chat with running agents, or an external session at work; a chat
 * waiting on the owner is idle unless it has running agents. Idle never starts before
 * the newest chat activity or the end of a keep awake.
 */
export class IdleMonitor {
  busy = false;
  idleSince: number | null = null;
  private keep: KeepAwake = OFF;
  /** When the last keep awake ended (null: none has). */
  private keepEnd: number | null = null;
  private readonly now: () => number;

  constructor(private readonly o: IdleMonitorOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Called every minute (and before status is read): moves busy and idleSince. */
  tick(): void {
    const sessions = this.o.sessions();
    this.busy =
      sessions.some(
        (s) =>
          (s.runningAgents ?? 0) > 0 ||
          (s.live && s.status !== 'needsYou' && IN_TURN.has(s.status)),
      ) || this.o.external().some((e) => e.status === 'busy' || e.state === 'working');
    if (this.busy) {
      this.idleSince = null;
      return;
    }
    // A turn that began and ended between two ticks still counts as activity.
    let since = this.idleSince ?? this.now();
    for (const s of sessions)
      if (s.lastActivity !== undefined && s.lastActivity > since) since = s.lastActivity;
    this.idleSince = since;
  }

  /** Ticks, then: busy now, or a chat active after `t` (a turn that began, and perhaps ended, since). */
  activeSince(t: number): boolean {
    this.tick();
    return (
      this.busy || this.o.sessions().some((s) => s.lastActivity !== undefined && s.lastActivity > t)
    );
  }

  /** The keep awake setting; an `until` that has passed reads as off. */
  get keepAwake(): KeepAwake {
    return this.expired(this.keep) ? OFF : this.keep;
  }

  setKeepAwake(k: KeepAwake): void {
    const ended = this.keepEndedAt();
    const next = k.mode === 'until' && (k.until === null || k.until <= this.now()) ? OFF : { ...k };
    this.keepEnd = this.keepAwake.mode !== 'off' && next.mode === 'off' ? this.now() : ended;
    this.keep = next;
  }

  /** Applies a stored keep awake at start; anything unusable or expired is off. */
  restoreKeepAwake(raw: unknown): void {
    const parsed = KeepAwakeSchema.safeParse(raw);
    this.keep = parsed.success && !this.expired(parsed.data) ? parsed.data : OFF;
  }

  /** When idle shutdown would start, or null (busy, never, or kept awake). */
  shutsDownAt(): number | null {
    const minutes = this.o.minutes();
    if (this.busy || this.idleSince === null || minutes === null) return null;
    if (this.keepAwake.mode !== 'off') return null;
    return Math.max(this.idleSince, this.keepEndedAt() ?? 0) + minutes * 60_000;
  }

  /** Starts a fresh idle period now (after a shutdown that did not happen); busy stays busy. */
  restart(): void {
    if (this.idleSince !== null) this.idleSince = this.now();
  }

  due(): boolean {
    const at = this.shutsDownAt();
    return at !== null && this.now() >= at;
  }

  private expired(k: KeepAwake): boolean {
    return k.mode === 'until' && (k.until === null || k.until <= this.now());
  }

  /** The moment keep awake last stopped holding the machine, or null. */
  private keepEndedAt(): number | null {
    if (this.keep.mode === 'until' && this.keep.until !== null && this.expired(this.keep)) {
      return this.keep.until;
    }
    return this.keepEnd;
  }
}
