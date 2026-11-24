import type { ShellRun } from '@threadgarden/protocol';
import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellOutput } from '../../src/lib/state/shell-output';

const h = vi.hoisted(() => {
  type Fake = {
    ops: unknown[][];
    options: Record<string, unknown>;
    opts: Record<string, unknown>;
    data: ((d: string) => void) | null;
    disposed: boolean;
    screen: string;
  };
  return {
    terms: [] as Fake[],
    dims: { cols: 80, rows: 24 } as { cols: number; rows: number } | undefined,
    lines: null as string[] | null,
    cursorY: 0,
    /** What the fake terminal answers a cursor-position query (ESC [ 6 n) with. */
    reply: '\u001b[1;1R',
    /**
     * Like xterm: `write` only queues, and the queue is parsed later (`flush`),
     * while `reset()` acts at once. Off: every write is parsed when made.
     */
    queued: false,
    pending: [] as Array<() => void>,
    flush(): void {
      for (const parse of this.pending.splice(0)) parse();
    },
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    ops: unknown[][] = [];
    options: Record<string, unknown>;
    data: ((d: string) => void) | null = null;
    disposed = false;
    lines: string[] = [];
    /** What the terminal shows: the parsed writes since its last reset (`reset()` or ESC c). */
    screen = '';
    element: { clientHeight: number };
    buffer: { active: object };
    cols: number;
    rows: number;
    constructor(public opts: Record<string, unknown>) {
      this.options = { ...opts };
      this.element = { clientHeight: (opts.rows as number) * 20 };
      const lines = () => this.lines;
      this.buffer = {
        active: {
          get length() {
            return lines().length;
          },
          baseY: 0,
          viewportY: 0,
          get cursorY() {
            return h.cursorY;
          },
          getLine: (i: number) => ({ translateToString: () => lines()[i] ?? '' }),
        },
      };
      this.cols = opts.cols as number;
      this.rows = opts.rows as number;
      h.terms.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    reset() {
      this.ops.push(['reset']);
      this.screen = '';
    }
    write(d: string, cb?: () => void) {
      this.ops.push(['write', d]);
      const parse = () => {
        // ESC c (a full reset) in the data clears the screen where it stands.
        const afterReset = d.split('\u001bc');
        this.screen = afterReset.length > 1 ? afterReset.at(-1)! : this.screen + d;
        if (h.lines) this.lines = h.lines.slice();
        // A real terminal answers queries in what it writes through onData.
        if (d.includes('\u001b[6n')) this.data?.(h.reply);
        cb?.();
      };
      if (h.queued) h.pending.push(parse);
      else parse();
    }
    resize(c: number, r: number) {
      this.ops.push(['resize', c, r]);
    }
    onData(cb: (d: string) => void) {
      this.data = cb;
      return { dispose() {} };
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return h.dims;
    }
  },
}));

import ShellBlock from '../../src/lib/components/chat/items/ShellBlock.svelte';
import ShellBlockSpread from './ShellBlockSpread.svelte';

const run = (over: Partial<ShellRun> = {}): ShellRun => ({
  runId: 'r1',
  sessionId: 's1',
  command: 'npm test',
  cwd: '/home/me/app',
  cols: 100,
  rows: 24,
  startedAt: Date.now() - 14_000,
  state: 'running',
  ...over,
});

const mount = (over: Partial<Parameters<typeof render<typeof ShellBlock>>[1]> = {}) => {
  const output = new ShellOutput();
  const props = {
    run: run(),
    output,
    machineName: 'kumbal',
    home: '/home/me',
    onInput: vi.fn(),
    onResize: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
  const view = render(ShellBlock, props as never);
  return { ...view, props, output: props.output as ShellOutput, term: h.terms.at(-1)! };
};

const observers: Array<() => void> = [];
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(cb: () => void) {
      observers.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

beforeEach(() => {
  observers.length = 0;
  h.terms.length = 0;
  h.dims = { cols: 80, rows: 24 };
  h.lines = null;
  h.cursorY = 0;
  h.queued = false;
  h.pending.length = 0;
  document.documentElement.style.removeProperty('--background');
  vi.restoreAllMocks();
});

describe('ShellBlock', () => {
  it('shows the title with ~ for home', () => {
    mount();
    expect(screen.getByText('! npm test · kumbal · ~/app')).toBeTruthy();
  });

  it('Stop calls onStop and then shows Stopping…', async () => {
    const { props } = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(props.onStop).toHaveBeenCalledTimes(1);
    const b = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });

  it('has no Stop button once the command ended', () => {
    mount({ run: run({ state: 'ended', exitCode: 0, endReason: 'exit', endedAt: Date.now() }) });
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull();
  });

  it('typing reaches onInput only while running', async () => {
    const { props, term, rerender } = mount();
    expect(term.options.disableStdin).toBe(false);
    term.data!('a');
    expect(props.onInput).toHaveBeenCalledWith('a');
    await rerender({
      ...props,
      run: run({ state: 'ended', exitCode: 0, endReason: 'exit' }),
    } as never);
    expect(term.options.disableStdin).toBe(true);
    term.data!('b');
    expect(props.onInput).toHaveBeenCalledTimes(1);
  });

  it('writes the scrollback, then new output; a reset clears first', () => {
    const output = new ShellOutput();
    output.reset('old\r\n', 0);
    const { term } = mount({ output });
    expect(term.ops).toEqual([['write', 'old\r\n']]);
    output.push(5, 'new');
    expect(term.screen).toBe('old\r\nnew');
    output.reset('fresh', 0);
    expect(term.screen).toBe('fresh');
  });

  describe('output waiting to be drawn (xterm parses writes later)', () => {
    it('a redraw replaces it, never draws on top of it', () => {
      h.queued = true;
      const output = new ShellOutput();
      output.reset('old\r\n', 0);
      const { term } = mount({ output });
      output.push(5, 'hi\r\n');
      output.reset('old\r\nhi\r\n', 0);
      h.flush();
      expect(term.screen).toBe('old\r\nhi\r\n');
    });

    it('the run changing (it ended, its entry was added) shows the output once', async () => {
      h.queued = true;
      const output = new ShellOutput();
      const block = {
        run: run(),
        output,
        machineName: 'kumbal',
        home: '/home/me',
        onInput: vi.fn(),
        onResize: vi.fn(),
        onStop: vi.fn(),
      };
      const { rerender } = render(ShellBlockSpread, { block } as never);
      const term = h.terms.at(-1)!;
      h.flush();
      output.push(0, 'hi\r\n');
      const ended = run({ state: 'ended', exitCode: 0, endReason: 'exit', endedAt: Date.now() });
      await rerender({ block: { ...block, run: ended } } as never);
      await rerender({ block: { ...block, run: { ...ended, entryId: 'e1' } } } as never);
      h.flush();
      expect(term.screen).toBe('hi\r\n');
    });
  });

  it("a replayed scrollback's terminal replies never reach the command", () => {
    const output = new ShellOutput();
    output.reset('where am I?\u001b[6n\r\n', 0);
    const { props, term } = mount({ output });
    output.reset('again\u001b[6n', 0);
    expect(props.onInput).not.toHaveBeenCalled();
    // Live output's replies, and typing, still go to the command.
    output.push(output.end, '\u001b[6n');
    expect(props.onInput).toHaveBeenCalledWith(h.reply);
    term.data!('y');
    expect(props.onInput).toHaveBeenLastCalledWith('y');
  });

  it('resizes at start for the starter and while focused, not otherwise', async () => {
    const other = mount();
    expect(other.props.onResize).not.toHaveBeenCalled();
    other.unmount();

    const starter = mount({ autofocus: true });
    expect(starter.props.onResize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    starter.unmount();

    const { props, container } = mount();
    const host = container.querySelector('[data-terminal]')!;
    h.dims = { cols: 60, rows: 24 };
    await fireEvent.focusIn(host);
    expect(props.onResize).toHaveBeenCalledWith({ cols: 60, rows: 24 });
    h.dims = { cols: 50, rows: 24 };
    for (const cb of observers) cb();
    expect(props.onResize).toHaveBeenLastCalledWith({ cols: 50, rows: 24 });
    await fireEvent.focusOut(host);
    (props.onResize as ReturnType<typeof vi.fn>).mockClear();
    h.dims = { cols: 40, rows: 24 };
    for (const cb of observers) cb();
    expect(props.onResize).not.toHaveBeenCalled();
  });

  it.each([
    [
      'exit 0',
      { exitCode: 0, endReason: 'exit' },
      '✓ exit 0 · 14s · Claude sees the output with your next message',
    ],
    [
      'exit 2',
      { exitCode: 2, endReason: 'exit' },
      '✗ exit 2 · 14s · Claude sees the output with your next message',
    ],
    [
      'stopped',
      { exitCode: null, endReason: 'stopped' },
      'Stopped · 14s · Claude sees the output with your next message',
    ],
    [
      'session',
      { exitCode: null, endReason: 'session' },
      'Stopped when the session ended · not added to the chat',
    ],
  ] as const)('footer for %s', (_n, over, text) => {
    const startedAt = 1_000_000;
    mount({ run: run({ ...over, state: 'ended', startedAt, endedAt: startedAt + 14_000 }) });
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('does not resize at start when the size is not known yet', () => {
    h.dims = undefined;
    const { props } = mount({ autofocus: true });
    expect(props.onResize).not.toHaveBeenCalled();
  });

  describe('height follows the content', () => {
    const hostHeight = (c: HTMLElement) =>
      (c.querySelector('[data-terminal]') as HTMLElement).style.height;

    it('a short output shows its lines, at least two rows', async () => {
      h.lines = ['hello'];
      const output = new ShellOutput();
      output.reset('hello', 0);
      const { container } = mount({ output });
      expect(hostHeight(container)).toBe('48px'); // 2 rows * 20px + 8px padding
      h.lines = ['a', 'b', 'c', 'd'];
      output.push(5, 'x');
      await tick();
      expect(hostHeight(container)).toBe('88px');
    });

    it('while running, the cursor row counts, so a prompt on a blank last line shows', async () => {
      h.lines = ['line 1', 'line 2', 'line 3'];
      h.cursorY = 3;
      const output = new ShellOutput();
      output.reset('x', 0);
      const { container, props, rerender } = mount({ output });
      expect(hostHeight(container)).toBe('88px'); // 4 rows * 20px + 8px
      await rerender({
        ...props,
        run: run({ state: 'ended', exitCode: 0, endReason: 'exit' }),
      } as never);
      output.push(1, 'y');
      await tick();
      expect(hostHeight(container)).toBe('68px'); // 3 rows once it ended
    });

    it('the cursor row never makes it taller than 24 rows', () => {
      h.lines = ['a'];
      h.cursorY = 400;
      const output = new ShellOutput();
      output.reset('x', 0);
      const { container } = mount({ output });
      expect(hostHeight(container)).toBe('488px');
    });

    it('a long output stops at 24 rows', () => {
      h.lines = Array.from({ length: 80 }, (_, i) => `line ${i}`);
      const output = new ShellOutput();
      output.reset('x', 0);
      const { container } = mount({ output });
      expect(hostHeight(container)).toBe('488px'); // 24 * 20 + 8
    });
  });

  describe('theme colours', () => {
    const canvas = (accepts: boolean) => {
      let fill = '';
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
        get fillStyle() {
          return fill;
        },
        set fillStyle(v: string) {
          if (accepts || v.startsWith('#')) fill = v;
        },
        clearRect() {},
        fillRect() {},
        getImageData: () => ({ data: [10, 20, 30, 255] }),
      })) as never);
    };
    const bg = () => document.documentElement.style.setProperty('--background', 'oklch(0.145 0 0)');

    it('reach xterm as rgb(), never oklch()', () => {
      bg();
      canvas(true);
      const { term } = mount();
      const theme = term.opts.theme as Record<string, string>;
      expect(theme.background).toBe('rgb(10, 20, 30)');
      expect(JSON.stringify(theme)).not.toContain('oklch(');
    });

    it('fall back to fixed colours when the browser cannot parse them', () => {
      bg();
      canvas(false);
      const { term } = mount();
      const theme = term.opts.theme as Record<string, string>;
      expect(theme.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(JSON.stringify(theme)).not.toContain('oklch(');
    });

    it('fall back when the probe throws', () => {
      bg();
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
        throw new Error('no canvas');
      });
      const { term } = mount();
      expect((term.opts.theme as Record<string, string>).background).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});
