/**
 * Router handlers for `!` commands (protocol 13): start a command in a chat's
 * folder, send it keystrokes, resize and stop it, read the chat's command.
 *
 * `shell.input` carries what the user types, passwords included. Its data goes
 * to the PTY and nowhere else: every failure here is a `ServiceError` (the
 * router never logs those) and no message mentions `data`.
 */
import { MOVE_ERRORS, SHELL_ERRORS } from '@threadgarden/protocol';
import type { LiveSession } from '../../chat/live-session.js';
import type { SessionHost } from '../../chat/session-host.js';
import { isCodexSession } from '../../sdk/providers.js';
import { ServiceError, type Router } from '../router.js';

export type ShellHandlerDeps = {
  host: SessionHost;
  /** The chat's live session, resuming it first when needed (`registerChatHandlers`). */
  resumedOrLive: (sessionId: string) => Promise<LiveSession>;
  /** An archived or held chat that is used returns to Active. */
  activate: (sessionId: string) => void;
  /** True while a move is exporting the chat. */
  isMoving?: (id: string) => boolean;
  /** The machine a chat moved to, when it moved away. */
  awayTo?: (id: string) => { name: string } | null | undefined;
};

export const registerShellHandlers = (router: Router, deps: ShellHandlerDeps): void => {
  const { host } = deps;

  const refuseMoved = (sessionId: string): void => {
    if (deps.isMoving?.(sessionId)) {
      throw new ServiceError(MOVE_ERRORS.moving, 'This chat is being moved to another machine');
    }
    const away = deps.awayTo?.(sessionId);
    if (away) throw new ServiceError(MOVE_ERRORS.moved, `This chat moved to ${away.name}`);
  };

  const running = (runId: string) => {
    const run = host.commandRun(runId);
    if (!run) throw new ServiceError(SHELL_ERRORS.notRunning, 'No command is running');
    return run;
  };

  /** A native PTY failure means the command is gone; its message never reaches the client. */
  const native = (act: () => void): Record<string, never> => {
    try {
      act();
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      throw new ServiceError(SHELL_ERRORS.notRunning, 'The command has ended');
    }
    return {};
  };

  router.register('shell.start', async (p) => {
    if (isCodexSession(p.sessionId)) {
      throw new ServiceError(SHELL_ERRORS.unsupported, '! commands are for Claude chats');
    }
    refuseMoved(p.sessionId);
    const s = await deps.resumedOrLive(p.sessionId);
    // The chat may have started moving while it resumed.
    refuseMoved(p.sessionId);
    deps.activate(p.sessionId);
    return s.startCommand(p.command, { cols: p.cols, rows: p.rows });
  });

  router.register('shell.input', async (p) => {
    const run = running(p.runId);
    return native(() => run.write(p.data));
  });

  router.register('shell.resize', async (p) => {
    const run = running(p.runId);
    return native(() => run.resize(p.cols, p.rows));
  });

  router.register('shell.stop', async (p) => {
    const run = running(p.runId);
    return native(() => run.stop());
  });

  router.register('shell.get', async (p) => ({ view: host.get(p.sessionId)?.command() ?? null }));
};
