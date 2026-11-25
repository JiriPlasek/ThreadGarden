import {
  SHELL_ERRORS,
  SHELL_SCROLLBACK_CHARS,
  type EventMsg,
  type ShellRun,
} from '@threadgarden/protocol';
import type { Timers } from '../chat/live-session.js';
import { ServiceError } from '../server/router.js';
import type { PtyFactory, PtyProcess } from './pty.js';
import type { ShellLine } from './shell-line.js';
import { limitOutput, terminalText } from './terminal-text.js';

export const SHELL_COALESCE_MS = 50;
export const SHELL_CHUNK_MAX_CHARS = 65_536;
export const SHELL_RATE_CHARS_PER_S = 524_288;
export const SHELL_STOP_GRACE_MS = 3_000;
export const SHELL_TRANSCRIPT_TAIL_CHARS = 1_048_576;
/** node-pty throws when `kill` gets a signal on Windows. */
const IS_WINDOWS = process.platform === 'win32';
export const SKIP_MARKER = '\r\n\u001b[2m[… output skipped here: too fast to show …]\u001b[0m\r\n';

export type ShellRunEnd = {
  exitCode: number | null;
  reason: 'exit' | 'stopped' | 'session';
  durationMs: number;
  transcript: string;
};

type Init = {
  runId: string;
  sessionId: string;
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
};

type Deps = {
  pty: PtyFactory;
  line: (command: string) => ShellLine;
  emit(e: EventMsg): void;
  now(): number;
  timers: Timers;
  onEnd(end: ShellRunEnd): void;
};

/** `text` cut to its last `max` characters, starting at a line start when there is a line break. */
const tailAtLine = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const kept = text.slice(text.length - max);
  const lineBreak = kept.indexOf('\n');
  return lineBreak >= 0 ? kept.slice(lineBreak + 1) : kept;
};

/** One `!` command in its own pseudo-terminal. Input goes to the PTY and nowhere else. */
export class PtyRun {
  private readonly run: ShellRun;
  private readonly pty: PtyProcess;
  private pending = '';
  private flushTimer: unknown;
  private graceTimer: unknown;
  private finalTimer: unknown;
  private emitted = 0;
  private scrollback = '';
  private raw = '';
  private rawTotal = 0;
  private windowStart: number;
  private windowChars = 0;
  private skipping = false;
  private stopRequested = false;
  private over = false;

  constructor(
    init: Init,
    private readonly deps: Deps,
  ) {
    const startedAt = deps.now();
    this.windowStart = startedAt;
    this.run = {
      runId: init.runId,
      sessionId: init.sessionId,
      command: init.command,
      cwd: init.cwd,
      cols: init.cols,
      rows: init.rows,
      startedAt,
      state: 'running',
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.env)) if (v !== undefined) env[k] = v;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    try {
      const { file, args } = deps.line(init.command);
      this.pty = deps.pty(file, args, {
        cwd: init.cwd,
        cols: init.cols,
        rows: init.rows,
        env,
        name: 'xterm-256color',
      });
    } catch (err) {
      throw new ServiceError(SHELL_ERRORS.failed, err instanceof Error ? err.message : String(err));
    }
    this.pty.onData((d) => this.onData(d));
    this.pty.onExit((e) =>
      this.finish(e.signal ? null : e.exitCode, this.stopRequested ? 'stopped' : 'exit'),
    );
    this.emitRun();
  }

  get info(): ShellRun {
    return { ...this.run };
  }

  get running(): boolean {
    return !this.over;
  }

  view(): { output: string; offset: number } {
    return { output: this.scrollback, offset: this.emitted - this.scrollback.length };
  }

  write(data: string): void {
    this.assertRunning();
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.assertRunning();
    this.pty.resize(cols, rows);
    this.run.cols = cols;
    this.run.rows = rows;
    this.emitRun();
  }

  stop(): void {
    this.assertRunning();
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.run.state = 'stopping';
    this.emitRun();
    this.graceTimer = this.deps.timers.setTimeout(() => {
      this.graceTimer = undefined;
      if (this.over) return;
      try {
        this.pty.kill();
      } catch {
        // already gone, or can't be signalled: the final timer ends the run
      }
      this.finalTimer = this.deps.timers.setTimeout(() => {
        this.finalTimer = undefined;
        if (this.over) return;
        if (!IS_WINDOWS) {
          try {
            this.pty.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
        this.finish(null, 'stopped');
      }, SHELL_STOP_GRACE_MS);
    }, SHELL_STOP_GRACE_MS);
    // After arming the timer, so a PTY that throws here still ends.
    this.pty.write('\x03');
  }

  kill(): void {
    if (this.over) return;
    try {
      this.pty.kill();
    } catch {
      // already gone
    }
    this.finish(null, 'session');
  }

  /** The appended entries' item ids: the `! command` line and its output. */
  markAppended(entryId: string, outputId?: string): void {
    this.run.entryId = entryId;
    if (outputId !== undefined) this.run.outputId = outputId;
    this.emitRun();
  }

  private assertRunning(): void {
    if (this.over) throw new ServiceError(SHELL_ERRORS.notRunning, 'The command has ended');
  }

  private emitRun(): void {
    this.deps.emit({ event: 'shell.run', data: this.info });
  }

  private onData(data: string): void {
    if (this.over) return;
    this.raw += data;
    this.rawTotal += data.length;
    if (this.raw.length > 2 * SHELL_TRANSCRIPT_TAIL_CHARS) {
      this.raw = this.raw.slice(this.raw.length - SHELL_TRANSCRIPT_TAIL_CHARS);
    }
    const now = this.deps.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowChars = 0;
    }
    const take = Math.max(0, Math.min(data.length, SHELL_RATE_CHARS_PER_S - this.windowChars));
    if (take > 0) {
      this.pending += take === data.length ? data : data.slice(0, take);
      this.windowChars += take;
      if (take === data.length) this.skipping = false;
    }
    if (take < data.length && !this.skipping) {
      this.skipping = true;
      this.pending += SKIP_MARKER;
    }
    if (this.pending && this.flushTimer === undefined) {
      this.flushTimer = this.deps.timers.setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, SHELL_COALESCE_MS);
    }
  }

  private flush(): void {
    if (this.flushTimer !== undefined) {
      this.deps.timers.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    while (this.pending) {
      const data = this.pending.slice(0, SHELL_CHUNK_MAX_CHARS);
      this.pending = this.pending.slice(data.length);
      this.deps.emit({
        event: 'shell.output',
        data: { runId: this.run.runId, sessionId: this.run.sessionId, offset: this.emitted, data },
      });
      this.emitted += data.length;
      this.scrollback += data;
      if (this.scrollback.length > SHELL_SCROLLBACK_CHARS) {
        this.scrollback = tailAtLine(this.scrollback, SHELL_SCROLLBACK_CHARS);
      }
    }
  }

  private finish(exitCode: number | null, reason: ShellRunEnd['reason']): void {
    if (this.over) return;
    this.flush();
    this.over = true;
    if (this.graceTimer !== undefined) this.deps.timers.clearTimeout(this.graceTimer);
    if (this.finalTimer !== undefined) this.deps.timers.clearTimeout(this.finalTimer);
    this.graceTimer = undefined;
    this.finalTimer = undefined;
    const endedAt = this.deps.now();
    this.run.state = 'ended';
    this.run.endedAt = endedAt;
    this.run.exitCode = exitCode;
    this.run.endReason = reason;
    this.emitRun();
    const tail = tailAtLine(this.raw, SHELL_TRANSCRIPT_TAIL_CHARS);
    const text = terminalText(tail);
    // When the start was dropped, CUT_NOTE counts it too.
    const transcript = limitOutput(text, text.length + (this.rawTotal - tail.length));
    this.deps.onEnd({ exitCode, reason, durationMs: endedAt - this.run.startedAt, transcript });
  }
}
