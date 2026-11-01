import type { ChatStatus, KeepAwake } from '@threadgarden/protocol';

const IN_TURN: ReadonlySet<ChatStatus> = new Set(['working', 'needsYou', 'unknown']);
const OFF: KeepAwake = { mode: 'off', until: null };

export type IdleMonitorOptions = {
  sessions: () => { live: boolean; status: ChatStatus; runningTasks?: number }[];
  external: () => { status?: string }[];
  /** The "Shut down after idle" setting; null is never. */
  minutes: () => number | null;
  now?: () => number;
};

/**
 * Tracks how long a headless machine has had nothing to do (spec §10). Busy is a live
 * chat in a turn, any chat with running tasks, or an external session at work; a chat
 * waiting on the owner is idle unless it has running tasks.
 */
export class IdleMonitor {
  busy = false;
  idleSince: number | null = null;
  private keep: KeepAwake = OFF;
  private readonly now: () => number;

  constructor(private readonly o: IdleMonitorOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Called every minute (and before status is read): moves busy and idleSince. */
  tick(): void {
    this.busy =
      this.o.sessions().some((s) => {
        const tasks = (s.runningTasks ?? 0) > 0;
        if (tasks) return true;
        return s.live && s.status !== 'needsYou' && IN_TURN.has(s.status);
      }) || this.o.external().some((e) => e.status === 'busy');
    if (this.busy) this.idleSince = null;
    else this.idleSince ??= this.now();
  }

  /** The keep awake setting; an `until` that has passed reads as off. */
  get keepAwake(): KeepAwake {
    const k = this.keep;
    if (k.mode === 'until' && (k.until === null || k.until <= this.now())) return OFF;
    return k;
  }

  setKeepAwake(k: KeepAwake): void {
    this.keep = k.mode === 'until' && (k.until === null || k.until <= this.now()) ? OFF : { ...k };
  }

  /** When idle shutdown would start, or null (busy, never, or kept awake). */
  shutsDownAt(): number | null {
    const minutes = this.o.minutes();
    if (this.busy || this.idleSince === null || minutes === null) return null;
    if (this.keepAwake.mode !== 'off') return null;
    return this.idleSince + minutes * 60_000;
  }

  due(): boolean {
    const at = this.shutsDownAt();
    return at !== null && this.now() >= at;
  }
}
