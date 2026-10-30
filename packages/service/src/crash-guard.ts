/**
 * The service's last line of defence (spec §2 anti-goal 4): one stray
 * rejection or exception must not take every running agent down with the
 * process. Both are logged and the service carries on. Only a storm of
 * uncaught exceptions — a sign that state is broken and the service is
 * looping on it — ends the process, after the log is flushed.
 */
import type { Logger } from './logger.js';

/** More uncaught exceptions than this within `STORM_WINDOW_MS` end the process. */
export const STORM_LIMIT = 10;
export const STORM_WINDOW_MS = 60_000;

type Target = {
  on(event: 'unhandledRejection' | 'uncaughtException', listener: (err: unknown) => void): unknown;
};

const describe = (err: unknown): string =>
  err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);

export const installCrashGuards = (
  proc: Target,
  o: {
    log: Pick<Logger, 'error' | 'flush'>;
    exit: (code: number) => void;
    now?: () => number;
  },
): void => {
  const now = o.now ?? Date.now;
  let recent: number[] = [];
  let exiting = false;

  proc.on('unhandledRejection', (err) => {
    o.log.error(`unhandled rejection (service keeps running): ${describe(err)}`);
  });

  proc.on('uncaughtException', (err) => {
    o.log.error(`uncaught exception (service keeps running): ${describe(err)}`);
    const t = now();
    recent = [...recent.filter((at) => t - at < STORM_WINDOW_MS), t];
    if (recent.length <= STORM_LIMIT || exiting) return;
    exiting = true;
    o.log.error(`${recent.length} uncaught exceptions within ${STORM_WINDOW_MS / 1000} s; exiting`);
    void o.log.flush().finally(() => o.exit(1));
  });
};
