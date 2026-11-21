/**
 * A trigger for `run` that never runs it twice at once and never drops a
 * request: asked while a run is going, it runs once more when that run ends
 * (any number of requests meanwhile make one more run). The run reads its
 * inputs when it starts, so the last one sees every change asked for before
 * it. `run` reports its own errors; a failed run does not stop the next.
 */
export const serialRunner = (run: () => Promise<void>): (() => void) => {
  let running = false;
  let again = false;
  const go = (): void => {
    running = true;
    again = false;
    void run()
      .catch(() => {})
      .finally(() => {
        running = false;
        if (again) go();
      });
  };
  return () => {
    if (running) again = true;
    else go();
  };
};
