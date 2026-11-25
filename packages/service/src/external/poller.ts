/**
 * External sessions (§6.3): Claude Code sessions running outside Threadgarden
 * (terminal, editor, `claude --bg`), read from the documented
 * `claude agents --json --all`. Output is parsed leniently (§2 anti-goal 3):
 * unknown fields are kept in `raw`, unknown values are passed through as text.
 */
import { execFile } from 'node:child_process';
import type { EventMsg } from '@threadgarden/protocol';
import { claudeInvocation } from '../sdk/claude-path';

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
  /** The entry as `claude agents` printed it, including fields Threadgarden does not know. */
  raw: Record<string, unknown>;
};

export const POLL_VISIBLE_MS = 2_000;
export const POLL_HIDDEN_MS = 10_000;
/**
 * Codex's shared runtime between polls: each reading opens a connection and
 * reads every loaded thread, too heavy for Claude's 2 s cadence. On-demand
 * readings (`current`: a resume check, Stop) always ask it afresh.
 */
export const CODEX_POLL_MS = 15_000;
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
      const { cmd, argv } = claudeInvocation(claudePath, args);
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
  /** Receives unexpected errors (a throwing `enabled`/`emit`); polling carries on. */
  onError?: (err: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout?: (t: NodeJS.Timeout) => void;
  /** Independent read-only Codex runtime source. Failure never hides Claude sessions. */
  codex?: () => Promise<ExternalSession[]>;
  codexEnabled?: () => boolean;
  /** The clock for Codex's cadence (`CODEX_POLL_MS`); defaults to `Date.now`. */
  now?: () => number;
};

export class ExternalPoller {
  available = false;
  private list: ExternalSession[] = [];
  private lastKey = '';
  private visible = true;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> | undefined;
  /** Whether the poll in flight asks Codex afresh (`refresh(true)`). */
  private inflightFresh = false;
  /** Codex's last reading, reused between polls until `CODEX_POLL_MS` has passed. */
  private codexReading: { at: number; list: ExternalSession[]; ok: boolean } | undefined;
  private sourceAvailable = { claude: false, codex: false };
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

  /** The sessions running outside Threadgarden (Threadgarden-owned ids excluded). */
  snapshot(): ExternalSession[] {
    return this.list.slice();
  }
  providerAvailable(runtime: 'claude' | 'codex'): boolean {
    return this.sourceAvailable[runtime];
  }

  /**
   * The external sessions right now, or null when `claude agents` is unusable.
   * Runs the command on demand even while background polling is switched off
   * (the `externalPolling` setting only governs polling and display), without
   * touching the polled snapshot in that case. Never rejects.
   */
  async current(provider?: 'claude' | 'codex'): Promise<ExternalSession[] | null> {
    try {
      if ((this.opts.enabled?.() ?? true) || (this.opts.codexEnabled?.() ?? false)) {
        await this.refresh(provider !== 'claude');
        return (provider ? this.sourceAvailable[provider] : this.available)
          ? this.snapshot().filter(
              (e) => !provider || (e.kind === 'codex' ? 'codex' : 'claude') === provider,
            )
          : null;
      }
      const result = await this.fetchSources(true, true);
      return (
        provider ? result.available[provider] : result.available.claude || result.available.codex
      )
        ? result.list.filter(
            (e) => !provider || (e.kind === 'codex' ? 'codex' : 'claude') === provider,
          )
        : null;
    } catch (err) {
      this.report(err);
      return null;
    }
  }

  /**
   * Polls now (joins a poll already running); never rejects. `freshCodex` asks
   * Codex's runtime even when its last reading is recent; it waits for a poll in
   * flight that would reuse it, then polls again.
   */
  refresh(freshCodex = false): Promise<void> {
    if (this.inflight && (!freshCodex || this.inflightFresh)) return this.inflight;
    const p: Promise<void> = (this.inflight ?? Promise.resolve())
      .then(() => this.poll(freshCodex))
      .finally(() => {
        if (this.inflight === p) {
          this.inflight = undefined;
          this.inflightFresh = false;
        }
      });
    this.inflight = p;
    this.inflightFresh = freshCodex;
    return p;
  }

  private cancel(): void {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.cancel();
    const t = this.setTimer(() => {
      this.timer = undefined;
      void this.refresh()
        .catch((err: unknown) => this.report(err))
        .finally(() => {
          if (this.started && !this.timer) {
            this.schedule(this.visible ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
          }
        });
    }, ms);
    t.unref?.();
    this.timer = t;
  }

  private report(err: unknown): void {
    try {
      this.opts.onError?.(err);
    } catch {
      // Nothing left to tell.
    }
  }

  /**
   * Runs `claude agents`; Threadgarden-owned sessions are left out. Rejects when
   * unusable. Threadgarden's own ids are read once the answer is in, so a session
   * Threadgarden started while the command ran (a chat, a title query) is left out too.
   */
  private async fetch(): Promise<ExternalSession[]> {
    const output = await this.run(AGENTS_ARGS);
    const own = this.ownIds();
    return parseAgents(output).filter((e) => e.sessionId === undefined || !own.has(e.sessionId));
  }

  private async fetchSources(
    claude: boolean,
    codex: boolean,
  ): Promise<{ list: ExternalSession[]; available: { claude: boolean; codex: boolean } }> {
    const results = await Promise.allSettled([
      claude ? this.fetch() : Promise.reject(new Error('Claude polling disabled')),
      codex && this.opts.codex
        ? this.opts.codex()
        : Promise.reject(new Error('Codex polling disabled')),
    ]);
    const own = this.ownIds();
    return {
      list: results
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .filter((e) => !e.sessionId || !own.has(e.sessionId)),
      available: {
        claude: results[0]!.status === 'fulfilled',
        codex: results[1]!.status === 'fulfilled',
      },
    };
  }

  private async poll(freshCodex = false): Promise<void> {
    try {
      let list: ExternalSession[] = [];
      let ok = false;
      const codexOn = (this.opts.codexEnabled?.() ?? false) && !!this.opts.codex;
      const now = (this.opts.now ?? Date.now)();
      const reuse =
        codexOn && !freshCodex && this.codexReading && now - this.codexReading.at < CODEX_POLL_MS
          ? this.codexReading
          : undefined;
      const result = await this.fetchSources(this.opts.enabled?.() ?? true, codexOn && !reuse);
      if (!codexOn) this.codexReading = undefined;
      else if (!reuse)
        this.codexReading = {
          at: now,
          list: result.list.filter((e) => e.kind === 'codex'),
          ok: result.available.codex,
        };
      if (reuse) {
        // Threadgarden may have started one of them since: own ids stay out.
        const own = this.ownIds();
        result.list.push(...reuse.list.filter((e) => !e.sessionId || !own.has(e.sessionId)));
        result.available.codex = reuse.ok;
      }
      list = result.list;
      this.sourceAvailable = result.available;
      ok = result.available.claude || result.available.codex;
      this.available = ok;
      this.list = list;
      const key = JSON.stringify([ok, list]);
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.emit({ event: 'external.changed', data: {} });
      }
    } catch (err) {
      this.report(err);
    }
  }
}
