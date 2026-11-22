/**
 * One chat's MCP servers (the "MCP servers (this chat)" dialog): the service
 * keeps the state; this mirrors it (`mcp.list`, then every `mcp.changed` of
 * this chat). No SDK message reports status changes, so the open dialog polls
 * (`startPolling`).
 *
 * Sign-in links and callback addresses pass through here only: they are never
 * stored.
 */
import type { McpState } from '@threadgarden/protocol';
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
      api.onOpen(() => this.load()),
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

  submitCallback = async (name: string, url: string): Promise<void> => {
    await this.api.request('mcp.submitCallback', { sessionId: this.sessionId, name, url });
    quietly(this.load());
  };

  act = async (
    name: string,
    action: 'reconnect' | 'enable' | 'disable' | 'clearAuth',
  ): Promise<void> => {
    await this.api.request('mcp.act', { sessionId: this.sessionId, name, action });
    quietly(this.load());
  };

  stop = (): void => {
    for (const off of this.offs) off();
    this.offs = [];
  };
}
