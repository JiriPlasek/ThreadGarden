/** Router handlers for external sessions, resume safety and system status. */
import type { ExternalPoller } from '../../external/poller.js';
import { checkResume, resumeCommand, type ResumeCheck } from '../../external/resume-safety.js';
import type { ClaudeFound, ClaudeProblem } from '../../sdk/claude-path.js';
import { ServiceError, type Router } from '../router.js';

export type ExternalHandlerDeps = {
  /** Absent when `claude` cannot be run; resume checks then answer `unverified`. */
  poller?: ExternalPoller;
  /**
   * Whether `claude agents` can be run right now (e.g. `claude` has been
   * located). While false, resume checks answer `unverified` without trying.
   * Default: always.
   */
  externalUsable?: () => boolean;
  /** `SDKSessionInfo.lastModified` from the history index; never a transcript stat. */
  lastModifiedOf: (sessionId: string) => number | undefined;
  /** Where `claude` was found, or why not; undefined while unknown. */
  claude: () => ClaudeFound | ClaudeProblem | undefined;
  /** Settles once a search for `claude` in progress has finished (answers wait for it). */
  located?: () => Promise<void>;
  indexing: () => { done: number; total: number };
  now?: () => number;
  /** Runs `claude <args>` (the poller's runner); needed by `external.stop`. */
  run?: (args: string[]) => Promise<string>;
};

/** Background-session short ids as `claude agents` prints them; anything else is refused. */
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_]*$/;

/**
 * Resume safety (§4.4) for `sessionId`, with a fresh `claude agents` answer
 * (not the up to 10 s old poll); `unverified` when the command is unusable.
 * Shared by `chat.resumeCheck` and the server-side gate in `chat.send`.
 */
export const makeResumeChecker =
  (
    deps: Pick<
      ExternalHandlerDeps,
      'poller' | 'externalUsable' | 'lastModifiedOf' | 'now' | 'located'
    >,
  ) =>
  async (sessionId: string): Promise<ResumeCheck> => {
    await deps.located?.();
    return checkResume({
      sessionId,
      external:
        deps.poller && (deps.externalUsable?.() ?? true) ? await deps.poller.current() : null,
      lastModified: deps.lastModifiedOf(sessionId) ?? 0,
      now: (deps.now ?? Date.now)(),
    });
  };

export const registerExternalHandlers = (router: Router, deps: ExternalHandlerDeps): void => {
  const { poller } = deps;
  const resumeCheck = makeResumeChecker(deps);

  router.register('ui.visibility', async (p) => {
    poller?.setVisible(p.visible);
    return {};
  });

  router.register('chat.resumeCheck', async (p) => resumeCheck(p.sessionId));

  router.register('chat.resumeCommand', async (p) => ({
    command: resumeCommand(p.sessionId, poller?.available ? poller.snapshot() : null),
  }));

  /**
   * Stops a background session run by Claude Code's own background service,
   * through its documented `claude stop <id>`. Sessions open in a terminal are
   * not Threadgarden's to stop.
   */
  router.register('external.stop', async (p) => {
    await deps.located?.();
    const usable = deps.externalUsable?.() ?? true;
    const list = poller && deps.run && usable ? await poller.current() : null;
    if (!list || !deps.run || !poller) {
      throw new ServiceError(
        'EXTERNAL_UNAVAILABLE',
        'Claude Code’s session list is not available.',
      );
    }
    const entry = list.find((e) => e.sessionId === p.sessionId);
    if (!entry) throw new ServiceError('NOT_EXTERNAL', 'This chat is not running outside Threadgarden.');
    if (entry.kind !== 'background' || !entry.shortId || !SHORT_ID.test(entry.shortId)) {
      throw new ServiceError('NOT_STOPPABLE', 'This chat is running in a terminal. Stop it there.');
    }
    try {
      await deps.run(['stop', entry.shortId]);
    } catch (err) {
      throw new ServiceError(
        'STOP_FAILED',
        `claude stop ${entry.shortId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await poller.refresh();
    return {};
  });

  router.register('system.status', async () => {
    // Not "missing" while still looking: the setup screen must not flash at start.
    await deps.located?.();
    const c = deps.claude();
    const claude =
      c === undefined
        ? { found: false, problem: 'Claude Code has not been located yet.' }
        : 'path' in c
          ? { found: true, path: c.path, version: c.version }
          : { found: false, problem: c.detail };
    return {
      claude,
      externalAvailable: poller?.available ?? false,
      indexing: deps.indexing(),
    };
  });
};
