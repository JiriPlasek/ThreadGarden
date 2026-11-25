/**
 * Router handlers for a chat's MCP servers (protocol 12). Claude Code owns the
 * connections; these only relay its control calls and read the project's files.
 * Every control failure becomes `MCP_FAILED` carrying Claude Code's own words,
 * which the router never logs. Nothing here passes params or results (sign-in
 * links, callback URLs) to `onError`.
 *
 * `mcp.add` / `mcp.remove` hand the change to Claude Code's CLI (`McpConfig`); header
 * and environment values only ever reach `config.add`, and are masked out of any
 * refusal before it is shown. A failure after the change itself (the reconnect or
 * restart that makes the chat see it) never fails the call.
 */
import { MCP_ERRORS, type EventMsg, type McpState } from '@threadgarden/protocol';
import { CONFIG_SEEN_BY, maskValues, type McpConfig } from '../../mcp/config.js';
import type { SessionHost } from '../../chat/session-host.js';
import type { McpControls } from '../../sdk/adapter.js';
import { isCodexSession } from '../../sdk/providers.js';
import { buildMcpState, signInUrl } from '../../mcp/state.js';
import type { McpProjectFiles } from '../../mcp/project-files.js';
import { ServiceError, type Router } from '../router.js';

export const registerMcpHandlers = (
  router: Router,
  deps: {
    host: SessionHost;
    files: McpProjectFiles;
    config: McpConfig;
    /** `host.restartWhenIdle`: true when the chat restarted now. Needed when a change is seen by restart. */
    restart?: (sessionId: string) => boolean;
    emit: (e: EventMsg) => void;
    onError: (err: unknown, context: string) => void;
  },
): { refresh(sessionId: string): Promise<void> } => {
  const { host, files } = deps;

  const failed = (err: unknown): ServiceError =>
    err instanceof ServiceError
      ? err
      : new ServiceError(MCP_ERRORS.failed, err instanceof Error ? err.message : String(err));

  /** A control call; an SDK without the method throws synchronously, so it is awaited in here. */
  const control = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw failed(err);
    }
  };

  const unsupported = (sessionId: string): void => {
    if (isCodexSession(sessionId)) {
      throw new ServiceError(MCP_ERRORS.unsupported, 'MCP servers are for Claude chats');
    }
  };

  const live = (sessionId: string) => {
    unsupported(sessionId);
    const s = host.get(sessionId);
    if (!s?.live) throw new ServiceError('NOT_LIVE', `Chat ${sessionId} is not running`);
    return s;
  };

  const stateOf = async (sessionId: string): Promise<McpState> => {
    const s = host.get(sessionId);
    if (!s?.live) return { sessionId, live: false, servers: [], waiting: [] };
    const controls = s.mcpControls();
    const statuses = await control(() => controls.status());
    return buildMcpState(sessionId, statuses, { names: await files.mcpJsonNames(s.cwd) });
  };

  const refresh = async (sessionId: string): Promise<void> => {
    if (isCodexSession(sessionId)) return;
    try {
      deps.emit({ event: 'mcp.changed', data: await stateOf(sessionId) });
    } catch (err) {
      // A chat that ended meanwhile has nothing to show; the message is Claude Code's own.
      if (err instanceof ServiceError) return;
      deps.onError(err, `mcp state of ${sessionId}`);
    }
  };

  const controlsOf = (sessionId: string): McpControls => live(sessionId).mcpControls();

  router.register('mcp.list', async (p) => {
    unsupported(p.sessionId);
    return stateOf(p.sessionId);
  });

  router.register('mcp.approve', async (p) => {
    const s = live(p.sessionId);
    const controls = s.mcpControls();
    if (!(await files.mcpJsonNames(s.cwd)).includes(p.name)) {
      throw new ServiceError(
        'INVALID_PARAMS',
        `"${p.name}" isn't a server in this project's .mcp.json`,
      );
    }
    await files.approve(s.cwd, p.name);
    const affected = [s.sessionId];
    try {
      await control(() => controls.reconnect(p.name));
    } finally {
      for (const other of host.liveIn(s.cwd)) {
        if (other.sessionId === s.sessionId) continue;
        affected.push(other.sessionId);
        try {
          await other.mcpControls().reconnect(p.name);
        } catch {
          // Only the chat and the server: Claude Code's message may carry more.
          deps.onError(
            new Error(`reconnect failed in chat ${other.sessionId} for ${p.name}`),
            'mcp',
          );
        }
      }
      await Promise.all(affected.map((id) => refresh(id)));
    }
    return {};
  });

  router.register('mcp.signIn', async (p) => {
    const controls = controlsOf(p.sessionId);
    const known = (await stateOf(p.sessionId)).servers.find((x) => x.name === p.name);
    if (known?.claudeAi) {
      throw new ServiceError('INVALID_PARAMS', 'Sign in to a claude.ai connector on claude.ai');
    }
    const url = signInUrl(await control(() => controls.authenticate(p.name)));
    await refresh(p.sessionId);
    return { url };
  });

  router.register('mcp.submitCallback', async (p) => {
    const controls = controlsOf(p.sessionId);
    await control(() => controls.submitCallback(p.name, p.url));
    await refresh(p.sessionId);
    return {};
  });

  router.register('mcp.act', async (p) => {
    const controls = controlsOf(p.sessionId);
    await control(async () => {
      if (p.action === 'reconnect') await controls.reconnect(p.name);
      else if (p.action === 'enable') await controls.toggle(p.name, true);
      else if (p.action === 'disable') await controls.toggle(p.name, false);
      else await controls.clearAuth(p.name);
    });
    await refresh(p.sessionId);
    return {};
  });

  /** Makes the live chat see a change Claude Code's CLI just made; answers `restartPending`. */
  const seen = async (
    sessionId: string,
    name: string,
    how: 'status' | 'reconnect' | 'restart',
    controls: McpControls,
  ): Promise<boolean> => {
    let restartPending = false;
    try {
      if (how === 'reconnect') await controls.reconnect(name);
      else if (how === 'restart') restartPending = !(deps.restart?.(sessionId) ?? false);
    } catch {
      // The change happened; the row shows the server's own status. Only the chat and server
      // are named: Claude Code's message may carry more.
      deps.onError(new Error(`could not apply the change in chat ${sessionId} for ${name}`), 'mcp');
    }
    return restartPending;
  };

  router.register('mcp.add', async (p) => {
    const s = live(p.sessionId);
    const controls = s.mcpControls();
    try {
      await deps.config.add({ cwd: s.cwd, scope: p.scope, name: p.name, config: p.config });
    } catch (err) {
      throw err instanceof ServiceError
        ? err
        : new ServiceError(
            MCP_ERRORS.failed,
            maskValues(err instanceof Error ? err.message : String(err), p.config),
          );
    }
    const restartPending = await seen(p.sessionId, p.name, CONFIG_SEEN_BY.add, controls);
    await refresh(p.sessionId);
    return { restartPending };
  });

  router.register('mcp.remove', async (p) => {
    const s = live(p.sessionId);
    const controls = s.mcpControls();
    try {
      await deps.config.remove({ cwd: s.cwd, scope: p.scope, name: p.name });
    } catch (err) {
      throw failed(err);
    }
    const restartPending = await seen(p.sessionId, p.name, CONFIG_SEEN_BY.remove, controls);
    await refresh(p.sessionId);
    return { restartPending };
  });

  return { refresh };
};
