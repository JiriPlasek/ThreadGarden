import type { PtyFactory, PtyProcess } from '../shell/pty.js';

/** How long the fake `sudo` takes to draw its progress bar, from 0 to 100 %. */
export const MOCK_PROGRESS_MS = 1500;
const PROGRESS_STEPS = 20;
const FLOOD_CHARS = 3 * 1024 * 1024;
const FLOOD_CHUNK_CHARS = 64 * 1024;

const GREEN = '\u001b[32m';
const BLUE = '\u001b[34m';
const RESET = '\u001b[0m';

type ExitCb = (e: { exitCode: number; signal?: number }) => void;

/**
 * A fake process on a fake terminal, scripted by its command (see `mockPty`). Like a real
 * terminal it echoes what is typed, except at a password prompt.
 */
class MockPtyProcess implements PtyProcess {
  readonly pid = 4243;
  private dataCb: (data: string) => void = () => {};
  private exitCb: ExitCb = () => {};
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private ended = false;
  private ignoresInterrupt = false;
  /** What a typed byte does: nothing special, a password (hidden) or a yes/no answer (shown). */
  private mode: 'none' | 'password' | 'confirm' = 'none';
  private typed = '';

  constructor(command: string) {
    // Output starts after the caller has attached its listeners, as a real process's does.
    this.after(0, () => this.start(command.trim()));
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: ExitCb): void {
    this.exitCb = cb;
  }

  write(data: string): void {
    if (this.ended) return;
    if (data.includes('\u0003') && !this.ignoresInterrupt) {
      this.emit('^C\r\n');
      this.end(130);
      return;
    }
    if (this.mode === 'none') return;
    for (const ch of data) {
      if (this.ended || this.isPlain()) return;
      if (ch === '\r' || ch === '\n') this.enter();
      else if (ch === '\u007f' || ch === '\b') {
        if (this.typed.length > 0 && this.mode === 'confirm') this.emit('\b \b');
        this.typed = this.typed.slice(0, -1);
      } else if (ch >= ' ') {
        this.typed += ch;
        if (this.mode === 'confirm') this.emit(ch);
      }
    }
  }

  resize(): void {}

  /** True when typing does nothing (`enter` changes the mode while a write is handled). */
  private isPlain(): boolean {
    return this.mode === 'none';
  }

  kill(): void {
    this.end(0, 9);
  }

  private emit(data: string): void {
    if (!this.ended) this.dataCb(data);
  }

  private end(exitCode: number, signal?: number): void {
    if (this.ended) return;
    this.ended = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.exitCb(signal === undefined ? { exitCode } : { exitCode, signal });
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  private start(command: string): void {
    const [word = '', arg] = command.split(/\s+/);
    if (word === 'sudo') {
      this.mode = 'password';
      this.emit('[sudo] password for mock: ');
    } else if (word === 'sleep') {
      const seconds = Number(arg);
      this.after((Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000, () =>
        this.end(0),
      );
    } else if (word === 'ignore-int') {
      this.ignoresInterrupt = true;
      this.emit('ignore-int: running, Ctrl-C does nothing here\r\n');
    } else if (word === 'flood') {
      this.flood(1, 0);
    } else if (word === 'exit') {
      const code = Number(arg);
      this.end(Number.isInteger(code) ? code : 0);
    } else if (word === 'ls') {
      this.emit(
        `${BLUE}docs${RESET}  ${BLUE}src${RESET}  package.json  README.md  ${GREEN}run.sh${RESET}\r\n`,
      );
      this.end(0);
    } else {
      this.emit(`mock: ${command}\r\n`);
      this.end(0);
    }
  }

  /** The password was entered, or an answer was given. */
  private enter(): void {
    if (this.mode === 'password') {
      this.mode = 'confirm';
      this.typed = '';
      this.emit('\r\nReading package lists... Done\r\nDo you want to continue? [Y/n] ');
      return;
    }
    const answer = this.typed.trim().toLowerCase();
    this.mode = 'none';
    this.emit('\r\n');
    if (answer === 'n') {
      this.emit('Abort.\r\n');
      this.end(1);
    } else this.progress(0);
  }

  /** A coloured bar, redrawn on one line with `\r`. */
  private progress(step: number): void {
    const percent = Math.round((step / PROGRESS_STEPS) * 100);
    const bar = '#'.repeat(step).padEnd(PROGRESS_STEPS, '.');
    this.emit(`\r${GREEN}[${bar}]${RESET} ${String(percent).padStart(3)}%`);
    if (step >= PROGRESS_STEPS) {
      this.emit('\r\nDone.\r\n');
      this.end(0);
    } else this.after(MOCK_PROGRESS_MS / PROGRESS_STEPS, () => this.progress(step + 1));
  }

  /** 3 MB of numbered lines, in chunks, as fast as the event loop allows. */
  private flood(next: number, written: number): void {
    if (this.ended) return;
    if (written >= FLOOD_CHARS) {
      this.end(0);
      return;
    }
    let chunk = '';
    let n = next;
    while (chunk.length < FLOOD_CHUNK_CHARS) chunk += `line ${n++}\r\n`;
    this.emit(chunk);
    const t = setImmediate(() => this.flood(n, written + chunk.length));
    t.unref();
  }
}

/**
 * The mock's fake terminal, scripted by the command (the shell wrapper's last argument):
 * `sudo …` (password, confirmation, progress bar), `sleep N`, `ignore-int`, `flood`,
 * `exit N`, `ls`; anything else prints `mock: ‹command›`.
 */
export const mockPty: PtyFactory = (_file, args) => new MockPtyProcess(args[args.length - 1] ?? '');
