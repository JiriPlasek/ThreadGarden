import { describe, expect, it } from 'vitest';
import { serialRunner } from '../src/serial.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('serialRunner', () => {
  it('runs once more after a run that was asked for again while it ran, never two at once', async () => {
    const runs: ReturnType<typeof deferred>[] = [];
    let running = 0;
    let most = 0;
    const trigger = serialRunner(async () => {
      running++;
      most = Math.max(most, running);
      const d = deferred();
      runs.push(d);
      await d.promise;
      running--;
    });
    trigger();
    expect(runs).toHaveLength(1);
    // Three requests during the first run, e.g. settings changed: one more run covers them.
    trigger();
    trigger();
    trigger();
    expect(runs).toHaveLength(1);
    runs[0]!.resolve();
    await expect.poll(() => runs.length).toBe(2);
    runs[1]!.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(runs).toHaveLength(2);
    expect(most).toBe(1);
    // Idle again: the next request starts at once.
    trigger();
    expect(runs).toHaveLength(3);
    runs[2]!.resolve();
  });

  it('carries on after a run that fails', async () => {
    let calls = 0;
    const trigger = serialRunner(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    trigger();
    trigger();
    await expect.poll(() => calls).toBe(2);
  });
});
