import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installCrashGuards } from '../src/crash-guard.js';

const setup = (now = () => 0) => {
  const proc = new EventEmitter();
  const errors: string[] = [];
  const exit = vi.fn();
  installCrashGuards(proc, {
    log: { error: (m) => void errors.push(m), flush: async () => {} },
    exit,
    now,
  });
  return { proc, errors, exit };
};

describe('installCrashGuards', () => {
  it('logs an unhandled rejection and keeps the service running', () => {
    const { proc, errors, exit } = setup();
    expect(proc.emit('unhandledRejection', new Error('lost promise'), Promise.resolve())).toBe(
      true,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unhandled rejection');
    expect(errors[0]).toContain('lost promise');
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs an uncaught exception and keeps the service (and every agent) running', () => {
    const { proc, errors, exit } = setup();
    expect(proc.emit('uncaughtException', new Error('stray throw'))).toBe(true);
    expect(errors[0]).toContain('uncaught exception');
    expect(errors[0]).toContain('stray throw');
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits after an exception storm (state is likely broken), once the log is flushed', async () => {
    let t = 0;
    const { proc, errors, exit } = setup(() => t);
    for (let i = 0; i < 10; i++) {
      proc.emit('uncaughtException', new Error(`e${i}`));
      t += 1_000;
    }
    expect(exit).not.toHaveBeenCalled();
    proc.emit('uncaughtException', new Error('one too many'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(errors.at(-1)).toContain('exiting');
  });

  it('spread-out exceptions never add up to a storm', () => {
    let t = 0;
    const { proc, exit } = setup(() => t);
    for (let i = 0; i < 50; i++) {
      proc.emit('uncaughtException', new Error(`e${i}`));
      t += 10_000;
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('non-Error values are logged too', () => {
    const { proc, errors } = setup();
    proc.emit('unhandledRejection', 'plain string', Promise.resolve());
    expect(errors[0]).toContain('plain string');
  });
});
