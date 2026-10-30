/**
 * Shared by the `*.perf.test.ts` files, which run in their own Vitest pass
 * (`vitest.perf.config.ts`: one file at a time, after the other tests) so
 * timings are not skewed by parallel test files.
 */

/** Budget multiplier for slower machines (`PAHUB_PERF_SLACK`, CI sets 3 — ruling R3). */
export const slack = Number(process.env.PAHUB_PERF_SLACK ?? 1);

/**
 * The fastest of `n` timed runs of `fn`, in ms: the cost of the work itself,
 * without one-off scheduler or GC pauses. Budgets are not relaxed by it; a
 * slow implementation is slow on every run.
 */
export const bestOf = async (n: number, fn: () => unknown): Promise<number> => {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
