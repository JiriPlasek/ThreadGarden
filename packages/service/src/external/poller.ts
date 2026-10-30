/**
 * External sessions (§6.3): Claude Code sessions running outside pahub
 * (terminal, editor, `claude --bg`), read from the documented
 * `claude agents --json --all`. Output is parsed leniently (§2 anti-goal 3):
 * unknown fields are kept in `raw`, unknown values are passed through as text.
 */
import { execFile } from 'node:child_process';
import type { EventMsg } from '@pahub/protocol';

export type ExternalSession = {
  /** The short id of a background session (`id`); `claude attach` takes it. */
  shortId?: string;
  sessionId?: string;
  cwd: string;
  kind: string;
  startedAt: number;
  /** Background sessions: `working|blocked|done|failed|stopped` (more may come). */
  state?: string;
  /** Live processes: `busy|waiting|idle` (more may come). */
  status?: string;
  waitingFor?: string;
  /** Present while the process is alive. */
  pid?: number;
  name?: string;
  /** The entry as `claude agents` printed it, including fields pahub does not know. */
  raw: Record<string, unknown>;
};

export const POLL_VISIBLE_MS = 2_000;
export const POLL_HIDDEN_MS = 10_000;
export const AGENTS_TIMEOUT_MS = 5_000;
export const AGENTS_ARGS = ['agents', '--json', '--all'];

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);
const num = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;

const parseEntry = (raw: Record<string, unknown>): ExternalSession => {
  const e: ExternalSession = {
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    kind: str(raw.kind) ?? 'unknown',
    startedAt: num(raw.startedAt) ?? 0,
    raw,
  };
  const optional = {
    shortId: str(raw.id),
    sessionId: str(raw.sessionId),
    state: str(raw.state),
    status: str(raw.status),
    waitingFor: str(raw.waitingFor),
    pid: num(raw.pid),
    name: str(raw.name),
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== undefined) (e as Record<string, unknown>)[k] = v;
  }
  return e;
};

/** Parses `claude agents --json` output; throws when it is not a JSON array. */
export const parseAgents = (stdout: string): ExternalSession[] => {
  const data: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(data)) throw new Error('claude agents did not print a JSON array');
  return data.filter(isRec).map(parseEntry);
};

/** Runs `claude <args>` directly (no shell) and resolves with stdout; rejects on failure or timeout. */
export const makeClaudeRunner =
  (claudePath: string) =>
  (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      // The SDK runs a .js/.mjs path with node; do the same here.
      const script = /\.(js|mjs)$/i.test(claudePath);
      const cmd = script ? process.execPath : claudePath;
      const argv = script ? [claudePath, ...args] : args;
      execFile(
        cmd,
        argv,
        {
          timeout: AGENTS_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });

export type PollerOptions = {
  /** Polling is skipped (and the feature reported unavailable) while this returns false. */
  enabled?: () => boolean;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (t: NodeJS.Timeout) => void;
};

export class ExternalPoller {
  available = false;
  private list: ExternalSession[] = [];
  private lastKey = '';
  private visible = true;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  private readonly setTimer: NonNullable<PollerOptions['setTimeout']>;
  private readonly clearTimer: NonNullable<PollerOptions['clearTimeout']>;

  constructor(
    private readonly run: (args: string[]) => Promise<string>,
    private readonly ownIds: () => Set<string>,
    private readonly emit: (e: EventMsg) => void,
    private readonly opts: PollerOptions = {},
  ) {
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((t) => clearTimeout(t));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.cancel();
  }

  /** The window became visible (2 s cadence) or hidden (10 s). */
  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    // A poll in flight reschedules itself with the new cadence when it ends.
    if (!this.started || this.inflight) return;
    this.cancel();
    this.schedule(v ? 0 : POLL_HIDDEN_MS);
  }

  /** The sessions running outside pahub (pahub-owned ids excluded). */
  snapshot(): ExternalSession[] {
    return this.list.slice();
  }

  /** Polls now (joins a poll already running); never rejects. */
  refresh(): Promise<void> {
    this.inflight ??= this.poll().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private cancel(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.cancel();
    const t = this.setTimer(() => {
      this.timer = undefined;
      void this.refresh().then(() => {
        if (this.started && !this.timer) {
          this.schedule(this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
        }
      });
    }, ms);
    t.unref?.();
    this.timer = t;
  }

  private async poll(): Promise<void> {
    let list: ExternalSession[] = [];
    let ok = false;
    if (this.opts.enabled?.() ?? true) {
      try {
        const own = this.ownIds();
        list = parseAgents(await this.run(AGENTS_ARGS)).filter(
          (e) => e.sessionId === undefined || !own.has(e.sessionId),
        );
        ok = true;
      } catch {
        // Missing, failing or disabled agent view: hide the feature, keep polling.
      }
    }
    this.available = ok;
    this.list = list;
    const key = JSON.stringify([ok, list]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.emit({ event: 'external.changed', data: {} });
    }
  }
}
