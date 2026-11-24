/**
 * Stand-ins for `@xterm/xterm` and `@xterm/addon-fit` in tests that render a
 * chat with a `!` command (jsdom has no canvas or layout for the real one):
 * `vi.mock('@xterm/xterm', () => import('./fake-xterm'))`. `terms` holds every
 * terminal made, so a test can see what was written and whether it took focus.
 */
export const terms: FakeTerminal[] = [];

export class FakeTerminal {
  written = '';
  focused = false;
  options: Record<string, unknown>;
  element = { clientHeight: 0 };
  buffer = { active: { length: 0, baseY: 0, getLine: () => undefined } };
  cols: number;
  rows: number;
  constructor(opts: Record<string, unknown>) {
    this.options = { ...opts };
    this.cols = opts.cols as number;
    this.rows = opts.rows as number;
    terms.push(this);
  }
  loadAddon(): void {}
  open(): void {}
  focus(): void {
    this.focused = true;
  }
  reset(): void {
    this.written = '';
  }
  write(data: string, done?: () => void): void {
    // ESC c (a full reset) clears what was written before it.
    const afterReset = data.split('\u001bc');
    this.written = afterReset.length > 1 ? afterReset.at(-1)! : this.written + data;
    done?.();
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  onData(): { dispose: () => void } {
    return { dispose: () => {} };
  }
  dispose(): void {}
}

export { FakeTerminal as Terminal };

export class FitAddon {
  proposeDimensions(): undefined {
    return undefined;
  }
}
