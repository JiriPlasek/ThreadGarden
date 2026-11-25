import { SHELL_SCROLLBACK_CHARS } from '@threadgarden/protocol';

/** Called with new output; `reset` is true for a full redraw (clear the terminal first). */
type Listener = (data: string, reset?: boolean) => void;

/**
 * The tail of a `!` command's output, kept in step with the service's offsets:
 * a chunk's `offset` is how many characters were emitted before it, so repeats
 * are dropped, overlaps trimmed and holes reported.
 */
export class ShellOutput {
  private buffer = '';
  private emitted = 0;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly limit = SHELL_SCROLLBACK_CHARS) {}

  /** Replaces everything with the service's scrollback, which ends at `offset + output.length`. */
  reset(output: string, offset: number): void {
    this.buffer = this.cap(output);
    this.emitted = offset + output.length;
    for (const fn of [...this.listeners]) fn(this.buffer, true);
  }

  /** Appends a chunk; `'gap'` when it starts after what we have (ask the service for the scrollback). */
  push(offset: number, data: string): 'ok' | 'gap' {
    if (offset > this.emitted) return 'gap';
    const fresh = data.slice(this.emitted - offset);
    if (fresh.length === 0) return 'ok';
    this.buffer = this.cap(this.buffer + fresh);
    this.emitted += fresh.length;
    for (const fn of [...this.listeners]) fn(fresh);
    return 'ok';
  }

  text(): string {
    return this.buffer;
  }

  /** How many characters have been emitted so far. */
  get end(): number {
    return this.emitted;
  }

  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private cap(s: string): string {
    return s.length > this.limit ? s.slice(s.length - this.limit) : s;
  }
}
