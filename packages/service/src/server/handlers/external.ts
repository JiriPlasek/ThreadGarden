/** Router handlers for external sessions, resume safety and system status. */
import type { ExternalPoller } from '../../external/poller.js';
import { checkResume, resumeCommand } from '../../external/resume-safety.js';
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

export const registerExternalHandlers = (router: Router, deps: ExternalHandlerDeps): void => {
  const { poller } = deps;
  const now = deps.now ?? Date.now;

  /** A fresh answer, so it is not up to 10 s stale; null when `claude agents` is unusable. */
  const externals = async () => (poller ? poller.current() : null);

  router.register('ui.visibility', async (p) => {
    poller?.setVisible(p.visible);
    return {};
  });

  router.register('chat.resumeCheck', async (p) =>
    checkResume({
      sessionId: p.sessionId,
      external: await externals(),
      lastModified: deps.lastModifiedOf(p.sessionId) ?? 0,
      now: now(),
    }),
  );

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
