/**
 * One chat's MCP servers (the "MCP servers (this chat)" dialog): the service
 * keeps the state; this mirrors it (`mcp.list`, then every `mcp.changed` of
 * this chat). No SDK message reports status changes, so the open dialog polls
 * (`startPolling`).
 *
 * Sign-in links and callback addresses pass through here only: they are never
 * stored.
 */
import type { McpScope, McpServerConfig, McpState } from '@threadgarden/protocol';
import type { Api } from './api';
import { quietly } from './api';

/** How often the open dialog re-reads the servers. */
export const MCP_POLL_MS = 3000;

export class ChatMcp {
  state = $state.raw<McpState | null>(null);

  private offs: (() => void)[] = [];
  /** Bumped by every state that arrives: an answer overtaken by a newer one is dropped. */
  private version = 0;

  constructor(
    private readonly api: Api,
    private readonly sessionId: string,
  ) {
    this.offs.push(
      api.on('mcp.changed', (s) => {
        if (s.sessionId === this.sessionId) this.set(s);
      }),
      api.onOpen(() => quietly(this.load())),
    );
  }

  private set = (s: McpState): void => {
    this.version++;
    this.state = s;
  };

  load = async (): Promise<void> => {
    const asked = this.version;
    const s = await this.api.request('mcp.list', { sessionId: this.sessionId });
    if (this.version === asked) this.set(s);
  };

  /** Re-reads the servers every `MCP_POLL_MS` until the returned function is called. */
  startPolling = (): (() => void) => {
    const timer = setInterval(() => quietly(this.load()), MCP_POLL_MS);
    return () => clearInterval(timer);
  };

  approve = async (name: string): Promise<void> => {
    await this.api.request('mcp.approve', { sessionId: this.sessionId, name });
    quietly(this.load());
  };

  /** The address to open, or null when there is nothing to open. */
  signIn = async (name: string): Promise<string | null> => {
    const { url } = await this.api.request('mcp.signIn', { sessionId: this.sessionId, name });
    return url;
  };

  /**
   * Claude Code saves the token after a good address but does not reconnect the
   * server, so this does (then reloads, as every action does). A refused address
   * rejects before any reconnect. `onSaved` runs once the address was accepted
   * (the code is spent), before the reconnect.
   */
  submitCallback = async (name: string, url: string, onSaved?: () => void): Promise<void> => {
    await this.api.request('mcp.submitCallback', { sessionId: this.sessionId, name, url });
    onSaved?.();
    await this.act(name, 'reconnect');
  };

  /**
   * `clearAuth` deletes the saved token but leaves the live connection up, so it
   * reconnects too: the server then shows Needs sign-in. A failed clearAuth does
   * not reconnect.
   */
  act = async (
    name: string,
    action: 'reconnect' | 'enable' | 'disable' | 'clearAuth',
  ): Promise<void> => {
    await this.api.request('mcp.act', { sessionId: this.sessionId, name, action });
    if (action === 'clearAuth') {
      await this.api.request('mcp.act', {
        sessionId: this.sessionId,
        name,
        action: 'reconnect',
      });
    }
    quietly(this.load());
  };

  /** Claude Code's CLI writes the server; `restartPending` says the live chat sees it only after a restart. */
  add = async (
    name: string,
    scope: McpScope,
    config: McpServerConfig,
  ): Promise<{ restartPending: boolean }> => {
    const r = await this.api.request('mcp.add', { sessionId: this.sessionId, name, scope, config });
    quietly(this.load());
    return r;
  };

  remove = async (name: string, scope: McpScope): Promise<{ restartPending: boolean }> => {
    const r = await this.api.request('mcp.remove', { sessionId: this.sessionId, name, scope });
    quietly(this.load());
    return r;
  };

  stop = (): void => {
    for (const off of this.offs) off();
    this.offs = [];
  };
}
