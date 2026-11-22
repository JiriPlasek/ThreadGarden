import type { ShellRun } from '@threadgarden/protocol';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellOutput } from '../../src/lib/state/shell-output';

const h = vi.hoisted(() => {
  type Fake = {
    ops: unknown[][];
    options: Record<string, unknown>;
    opts: Record<string, unknown>;
    data: ((d: string) => void) | null;
    disposed: boolean;
  };
  return {
    terms: [] as Fake[],
    dims: { cols: 80, rows: 24 } as { cols: number; rows: number } | undefined,
  };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    ops: unknown[][] = [];
    options: Record<string, unknown>;
    data: ((d: string) => void) | null = null;
    disposed = false;
    cols: number;
    rows: number;
    constructor(public opts: Record<string, unknown>) {
      this.options = { ...opts };
      this.cols = opts.cols as number;
      this.rows = opts.rows as number;
      h.terms.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    reset() {
      this.ops.push(['reset']);
    }
    write(d: string) {
      this.ops.push(['write', d]);
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
    output.reset('fresh', 0);
    expect(term.ops.slice(1)).toEqual([['write', 'new'], ['reset'], ['write', 'fresh']]);
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
});
