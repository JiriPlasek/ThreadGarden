import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_SCROLLBACK_CHARS, type EventMsg } from '@threadgarden/protocol';
import { CUT_NOTE } from '../../src/shell/terminal-text.js';
import {
  PtyRun,
  SHELL_CHUNK_MAX_CHARS,
  SHELL_RATE_CHARS_PER_S,
  SHELL_STOP_GRACE_MS,
  SKIP_MARKER,
  type ShellRunEnd,
} from '../../src/shell/run.js';
import { fakePtyFactory } from '../../src/testing/fake-pty.js';

const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
};

const setup = (
  over: { env?: Record<string, string | undefined>; pty?: ReturnType<typeof fakePtyFactory> } = {},
) => {
  const pty = over.pty ?? fakePtyFactory();
  const events: EventMsg[] = [];
  const ends: ShellRunEnd[] = [];
  const run = new PtyRun(
    {
      runId: 'r1',
      sessionId: 's1',
      command: 'echo hi',
      cwd: '/work/app',
      cols: 90,
      rows: 20,
      env: over.env ?? { PATH: '/bin', GONE: undefined },
    },
    {
      pty: pty.factory,
      line: (c) => ({ file: 'bash', args: ['-lic', c] }),
      emit: (e) => events.push(e),
      now: () => Date.now(),
      timers,
      onEnd: (e) => ends.push(e),
    },
  );
  const outputs = () =>
    events
      .filter((e) => e.event === 'shell.output')
      .map((e) => e.data as { offset: number; data: string });
  const runs = () =>
    events.filter((e) => e.event === 'shell.run').map((e) => e.data as { state: string });
  return { pty, run, events, ends, outputs, runs };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('PtyRun', () => {
  it("starts the shell line in the chat's folder with the size and TERM", () => {
    const t = setup();
    const { spawned } = t.pty.last();
    expect(spawned.file).toBe('bash');
    expect(spawned.args).toEqual(['-lic', 'echo hi']);
    expect(spawned.o.cwd).toBe('/work/app');
    expect(spawned.o.cols).toBe(90);
    expect(spawned.o.rows).toBe(20);
    expect(spawned.o.env).toEqual({ PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    expect(t.runs()).toHaveLength(1);
    expect(t.run.info.state).toBe('running');
    expect(t.run.running).toBe(true);
  });

  it('coalesces output into chunks with running offsets', () => {
    const t = setup();
    const p = t.pty.last();
    p.emit('aaa');
    vi.advanceTimersByTime(10);
    p.emit('bbb');
    vi.advanceTimersByTime(10);
    p.emit('ccc');
    expect(t.outputs()).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(t.outputs()).toEqual([expect.objectContaining({ offset: 0, data: 'aaabbbccc' })]);
    p.emit('dd');
    vi.advanceTimersByTime(100);
    expect(t.outputs()[1]).toMatchObject({ offset: 9, data: 'dd' });
  });

  it('a flood is rate-capped and the transcript keeps the end', () => {
    const t = setup();
    const p = t.pty.last();
    const piece = `${'x'.repeat(99_999)}\n`;
    for (let i = 0; i < 50; i++) {
      p.emit(piece);
      vi.advanceTimersByTime(10);
    }
    p.emit('the last line\n');
    vi.advanceTimersByTime(100);
    const total = t.outputs().reduce((n, e) => n + e.data.length, 0);
    expect(total).toBeLessThanOrEqual(
      SHELL_RATE_CHARS_PER_S + SHELL_CHUNK_MAX_CHARS + SKIP_MARKER.length,
    );
    expect(t.outputs().some((e) => e.data.includes(SKIP_MARKER))).toBe(true);
    expect(t.outputs().every((e) => e.data.length <= SHELL_CHUNK_MAX_CHARS)).toBe(true);
    expect(t.run.view().output.length).toBeLessThanOrEqual(SHELL_SCROLLBACK_CHARS);
    p.exit(0);
    const end = t.ends[0];
    expect(end?.transcript.endsWith('the last line')).toBe(true);
    // The full output is 50 lines of 99 999 x's and the last line: 5 000 013 characters.
    expect(end?.transcript.startsWith(`${CUT_NOTE.replace('‹N›', '5000013')}\n`)).toBe(true);
  });

  it("attach mid-run continues from the scrollback's offset", () => {
    const t = setup();
    const p = t.pty.last();
    for (let i = 0; i < 4; i++) {
      p.emit(`${'y'.repeat(99_999)}\n`);
      vi.advanceTimersByTime(60);
    }
    const total = t.outputs().reduce((n, e) => n + e.data.length, 0);
    expect(total).toBe(400_000);
    const v = t.run.view();
    expect(v.output.length).toBeLessThanOrEqual(SHELL_SCROLLBACK_CHARS);
    expect(v.offset).toBeGreaterThan(0);
    expect(v.offset + v.output.length).toBe(total);
    p.emit('more\n');
    vi.advanceTimersByTime(60);
    expect(t.outputs().at(-1)?.offset).toBe(v.offset + v.output.length);
  });

  it('input reaches the PTY and is never recorded', () => {
    const t = setup();
    const p = t.pty.last();
    t.run.write('hunter2\r');
    expect(p.written).toEqual(['hunter2\r']);
    p.emit('Password: ');
    vi.advanceTimersByTime(100);
    p.exit(0);
    expect(JSON.stringify(t.events)).not.toContain('hunter2');
    expect(JSON.stringify(t.run.info)).not.toContain('hunter2');
    expect(JSON.stringify(t.run.view())).not.toContain('hunter2');
    expect(t.ends[0]?.transcript).not.toContain('hunter2');
  });

  it('stop sends Ctrl+C, then kills after the grace period', () => {
    const t = setup();
    const p = t.pty.last();
    t.run.stop();
    expect(p.written.at(-1)).toBe('\x03');
    expect(t.runs().at(-1)?.state).toBe('stopping');
    expect(t.run.info.state).toBe('stopping');
    vi.advanceTimersByTime(SHELL_STOP_GRACE_MS - 1);
    expect(p.kills).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(p.kills).toHaveLength(1);
    p.exit(137);
    expect(t.ends[0]?.reason).toBe('stopped');

    const u = setup();
    u.run.stop();
    u.pty.last().exit(130);
    vi.advanceTimersByTime(SHELL_STOP_GRACE_MS * 2);
    expect(u.pty.last().kills).toHaveLength(0);
    expect(u.ends[0]).toMatchObject({ reason: 'stopped', exitCode: 130 });
  });

  it('a stop whose exit never arrives still ends, stopped, after a second grace period', () => {
    const t = setup();
    const p = t.pty.last();
    p.kill = (signal?: string) => {
      p.kills.push(signal);
      throw new Error('kill failed');
    };
    t.run.stop();
    vi.advanceTimersByTime(SHELL_STOP_GRACE_MS);
    expect(p.kills).toEqual([undefined]);
    expect(t.ends).toHaveLength(0);
    vi.advanceTimersByTime(SHELL_STOP_GRACE_MS);
    // node-pty throws when given a signal on Windows, so there it only gets the plain kill.
    expect(p.kills).toEqual(process.platform === 'win32' ? [undefined] : [undefined, 'SIGKILL']);
    expect(t.ends).toEqual([expect.objectContaining({ reason: 'stopped', exitCode: null })]);
    expect(t.run.info.state).toBe('ended');
    expect(t.run.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    p.exit(0);
    expect(t.ends).toHaveLength(1);
  });

  it('resize resizes the PTY and re-emits the run with its size', () => {
    const t = setup();
    t.run.resize(120, 30);
    expect(t.pty.last().resizes).toEqual([{ cols: 120, rows: 30 }]);
    expect(t.events.at(-1)).toMatchObject({ event: 'shell.run', data: { cols: 120, rows: 30 } });
    expect(t.run.info).toMatchObject({ cols: 120, rows: 30 });
  });

  it('exit reports code, duration and the cleaned transcript', () => {
    const t = setup();
    const p = t.pty.last();
    p.emit('\u001b[32mgreen\u001b[0m\r\nline2\r\n');
    vi.advanceTimersByTime(2_500);
    p.exit(3);
    expect(t.ends).toEqual([
      { exitCode: 3, reason: 'exit', durationMs: 2_500, transcript: 'green\nline2' },
    ]);
    expect(t.run.running).toBe(false);
    expect(t.run.info).toMatchObject({
      state: 'ended',
      exitCode: 3,
      endReason: 'exit',
      endedAt: 1_002_500,
    });
    expect(
      t
        .outputs()
        .map((e) => e.data)
        .join(''),
    ).toContain('green');
  });

  it('a signal exit has no code', () => {
    const t = setup();
    t.pty.last().exit(0, 9);
    expect(t.ends[0]?.exitCode).toBeNull();
  });

  it('kill ends at once with reason session', () => {
    const t = setup();
    t.pty.last().emit('partial');
    t.run.kill();
    expect(t.pty.last().kills).toHaveLength(1);
    expect(t.ends).toHaveLength(1);
    expect(t.ends[0]).toMatchObject({ reason: 'session', exitCode: null });
    expect(t.run.info.endReason).toBe('session');
    t.pty.last().exit(1);
    expect(t.ends).toHaveLength(1);
  });

  it('markAppended sets the entry and output ids and re-emits the run', () => {
    const t = setup();
    t.pty.last().exit(0);
    t.run.markAppended('item-1', 'item-2');
    expect(t.run.info).toMatchObject({ entryId: 'item-1', outputId: 'item-2' });
    expect(t.events.at(-1)).toMatchObject({
      event: 'shell.run',
      data: { entryId: 'item-1', outputId: 'item-2' },
    });
  });

  it('a spawn failure is SHELL_FAILED', () => {
    expect(
      () =>
        new PtyRun(
          { runId: 'r', sessionId: 's', command: 'x', cwd: '/', cols: 80, rows: 24, env: {} },
          {
            pty: () => {
              throw new Error('no such shell');
            },
            line: () => ({ file: 'nope', args: [] }),
            emit: () => {},
            now: () => 0,
            timers,
            onEnd: () => {},
          },
        ),
    ).toThrowError(expect.objectContaining({ code: 'SHELL_FAILED', message: 'no such shell' }));
  });

  it('after the end, write, resize and stop say SHELL_NOT_RUNNING', () => {
    const t = setup();
    t.pty.last().exit(0);
    for (const act of [() => t.run.write('x'), () => t.run.resize(80, 24), () => t.run.stop()]) {
      expect(act).toThrowError(
        expect.objectContaining({ code: 'SHELL_NOT_RUNNING', message: 'The command has ended' }),
      );
    }
  });
});
