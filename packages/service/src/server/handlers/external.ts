/** Router handlers for external sessions, resume safety and system status. */
import type { ExternalPoller } from '../../external/poller.js';
import { checkResume, resumeCommand, type ResumeCheck } from '../../external/resume-safety.js';
import type { ClaudeFound, ClaudeProblem } from '../../sdk/claude-path.js';
import type { Router } from '../router.js';

export type ExternalHandlerDeps = {
  /** Absent when `claude` is not available; resume checks then answer `unverified`. */
  poller?: ExternalPoller;
  /** `SDKSessionInfo.lastModified` from the history index; never a transcript stat. */
  lastModifiedOf: (sessionId: string) => number | undefined;
  /** Where `claude` was found, or why not; undefined while unknown. */
  claude: () => ClaudeFound | ClaudeProblem | undefined;
  indexing: () => { done: number; total: number };
  now?: () => number;
};

/**
 * Resume safety (§4.4) for `sessionId`, with a fresh `claude agents` answer
 * (not the up to 10 s old poll); `unverified` when the command is unusable.
 * Shared by `chat.resumeCheck` and the server-side gate in `chat.send`.
 */
export const makeResumeChecker =
  (deps: Pick<ExternalHandlerDeps, 'poller' | 'lastModifiedOf' | 'now'>) =>
  async (sessionId: string): Promise<ResumeCheck> =>
    checkResume({
      sessionId,
      external: deps.poller ? await deps.poller.current() : null,
      lastModified: deps.lastModifiedOf(sessionId) ?? 0,
      now: (deps.now ?? Date.now)(),
    });

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

  router.register('system.status', async () => {
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
