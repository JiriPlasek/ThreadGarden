/**
 * Following a clone job on its machine: `projects.job` every second until it
 * settles, and cancelling it once (Cancel, or the Clone tab going away).
 */
import type { CloneJob } from '@threadgarden/protocol';
import type { ProjectsApi } from '#lib/projects.js';

export const CLONE_POLL_MS = 1000;
/** Polls failing in a row before the job is given up (a relay hiccup is not a lost job). */
export const CLONE_POLL_TRIES = 3;

export type CloneWatch = {
  /** The job once it is no longer running; null when cancelled first. Rejects when polls keep failing. */
  settled: Promise<CloneJob | null>;
  /** Stops polling and cancels the job, unless it has settled or was already cancelled. */
  cancel: () => void;
};

/** Polls `first` on `api` (the machine it was started on) until it settles or `cancel()`. */
export const watchClone = (
  api: Pick<ProjectsApi, 'job' | 'cancel'>,
  first: CloneJob,
): CloneWatch => {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake = (): void => {};

  const cancel = (): void => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    wake();
    api.cancel(first.jobId).catch(() => {});
  };

  const follow = async (): Promise<CloneJob | null> => {
    let job = first;
    let failed = 0;
    while (job.state === 'running') {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, CLONE_POLL_MS);
      });
      if (over) return null;
      try {
        job = await api.job(first.jobId);
        failed = 0;
      } catch (err) {
        if (over) return null;
        if (++failed < CLONE_POLL_TRIES) continue;
        // The job can't be followed any more: stop it rather than leave it half-made.
        cancel();
        throw err;
      }
      if (over) return null;
    }
    over = true;
    return job;
  };

  return { settled: follow(), cancel };
};
