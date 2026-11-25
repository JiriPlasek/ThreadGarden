import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  MoveBusySchema,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_RANGE,
  SHELL_CAPABILITY,
  SHELL_COMMAND_MAX,
  SHELL_DEFAULT_SIZE,
  SHELL_ERRORS,
  SHELL_INPUT_MAX,
  SHELL_SCROLLBACK_CHARS,
  ShellRunSchema,
  ShellViewSchema,
  events,
  methods,
} from '../src/index.js';

const SHELL_METHODS = ['shell.start', 'shell.input', 'shell.resize', 'shell.stop', 'shell.get'] as const;

describe('protocol 13', () => {
  it('PROTOCOL_VERSION is 13 and the remote range is 12..14', () => {
    expect(PROTOCOL_VERSION).toBe(13);
    expect(REMOTE_PROTOCOL_RANGE).toEqual({ min: 12, max: 14 });
  });

  it("SHELL_CAPABILITY is 'shell' and not in CAPABILITIES", () => {
    expect(SHELL_CAPABILITY).toBe('shell');
    expect(CAPABILITIES).not.toContain('shell');
    expect(Object.values(SHELL_ERRORS)).toEqual([
      'SHELL_UNSUPPORTED',
      'SHELL_BUSY',
      'SHELL_NOT_RUNNING',
      'SHELL_FAILED',
    ]);
    expect([SHELL_COMMAND_MAX, SHELL_INPUT_MAX, SHELL_SCROLLBACK_CHARS]).toEqual([16_384, 65_536, 262_144]);
    expect(SHELL_DEFAULT_SIZE).toEqual({ cols: 100, rows: 24 });
  });

  it('shell.* methods and events are listed', () => {
    for (const m of SHELL_METHODS) {
      expect(Object.keys(methods), m).toContain(m);
      expect((methods as Record<string, { localOnly?: boolean }>)[m]?.localOnly, m).toBeFalsy();
    }
    expect(Object.keys(events)).toContain('shell.run');
    expect(Object.keys(events)).toContain('shell.output');
    const run = {
      runId: 'r',
      sessionId: 's',
      command: 'ls',
      cwd: '/x',
      cols: 100,
      rows: 24,
      startedAt: 1,
      state: 'running',
    };
    expect(ShellRunSchema.safeParse(run).success).toBe(true);
    expect(
      ShellRunSchema.safeParse({ ...run, state: 'ended', endedAt: 2, exitCode: null, endReason: 'session', entryId: 'e' })
        .success,
    ).toBe(true);
    expect(ShellRunSchema.safeParse({ ...run, state: 'paused' }).success).toBe(false);
    expect(ShellViewSchema.safeParse({ run, output: 'x', offset: 0 }).success).toBe(true);
    expect(methods['shell.get'].result.safeParse({ view: null }).success).toBe(true);
    expect(events['shell.output'].safeParse({ runId: 'r', sessionId: 's', offset: 3, data: 'a' }).success).toBe(true);
  });

  it('shell.start refuses an empty or whitespace command and one over SHELL_COMMAND_MAX', () => {
    const p = methods['shell.start'].params;
    const base = { sessionId: 's', cols: 100, rows: 24 };
    expect(p.safeParse({ ...base, command: '' }).success).toBe(false);
    expect(p.safeParse({ ...base, command: '   \n ' }).success).toBe(false);
    expect(p.safeParse({ ...base, command: 'a'.repeat(SHELL_COMMAND_MAX) }).success).toBe(true);
    expect(p.safeParse({ ...base, command: 'a'.repeat(SHELL_COMMAND_MAX + 1) }).success).toBe(false);
  });

  it("shell.input refuses data over SHELL_INPUT_MAX, and the error message doesn't contain the data", () => {
    const p = methods['shell.input'].params;
    expect(p.safeParse({ runId: 'r', data: 'x'.repeat(SHELL_INPUT_MAX) }).success).toBe(true);
    const r = p.safeParse({ runId: 'r', data: 'hunter2'.repeat(10_000) });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain('hunter2');
  });

  it('sizes outside 2..1000 × 2..500 are refused', () => {
    for (const m of ['shell.start', 'shell.resize'] as const) {
      const p = methods[m].params;
      const extra = m === 'shell.start' ? { sessionId: 's', command: 'ls' } : { runId: 'r' };
      const ok = (cols: number, rows: number) => p.safeParse({ ...extra, cols, rows }).success;
      expect(ok(2, 2), m).toBe(true);
      expect(ok(1000, 500), m).toBe(true);
      expect(ok(1, 24), m).toBe(false);
      expect(ok(1001, 24), m).toBe(false);
      expect(ok(100, 1), m).toBe(false);
      expect(ok(100, 501), m).toBe(false);
      expect(ok(100.5, 24), m).toBe(false);
    }
  });

  it('chat.open parses with and without shell', () => {
    const result = methods['chat.open'].result;
    const withoutShell = result.safeParse({});
    // The base shape is large; check the shell field alone through its schema instead.
    expect(withoutShell.success).toBe(false);
    const shape = (result as unknown as { shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }> }).shape;
    expect(shape.shell?.safeParse(undefined).success).toBe(true);
    const run = { runId: 'r', sessionId: 's', command: 'ls', cwd: '/x', cols: 2, rows: 2, startedAt: 1, state: 'running' };
    expect(shape.shell?.safeParse({ run, output: '', offset: 0 }).success).toBe(true);
    expect(shape.shell?.safeParse({ run }).success).toBe(false);
  });

  it("move busy accepts 'command'", () => {
    expect(MoveBusySchema.safeParse('command').success).toBe(true);
  });
});
