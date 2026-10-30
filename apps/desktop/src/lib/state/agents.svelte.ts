import type { ChatSummary } from '@pahub/protocol';
import { quietly, type Api } from './api';

/** More agents than this at once is not a realistic workload; the strip shows what fits. */
export const AGENTS_LIMIT = 200;

/**
 * Every running agent across all projects, pahub chats and external sessions alike
 * (spec §6.1 bottom strip): the "Needs you" chats first, then the working ones.
 */
export class AgentsState {
  items = $state.raw<ChatSummary[]>([]);
  needsYou = $derived(this.items.filter((s) => s.status === 'needsYou').length);

  private api: Api | null = null;
  private inflight: Promise<void> | null = null;
  private again = false;

  init = (api: Api): void => {
    this.api = api;
    const refresh = () => quietly(this.refresh());
    api.on('sessions.changed', refresh);
    api.on('external.changed', refresh);
    api.on('chat.status', refresh);
    api.onOpen(() => this.refresh());
    if (api.status === 'open') refresh();
  };

  /** Re-fetches both lists; overlapping calls coalesce into one trailing fetch. */
  refresh = (): Promise<void> => {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    const api = this.api;
    if (!api) return Promise.resolve();
    this.inflight = (async () => {
      try {
        do {
          this.again = false;
          const [needsYou, running] = await Promise.all([
            api.request('sessions.list', { place: { kind: 'needsYou' }, limit: AGENTS_LIMIT }),
            api.request('sessions.list', { place: { kind: 'running' }, limit: AGENTS_LIMIT }),
          ]);
          this.items = mergeAgents(needsYou.items, running.items);
        } while (this.again);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  };

  stopAll = async (): Promise<number> => {
    if (!this.api) return 0;
    const { stopped } = await this.api.request('work.stopAll', {});
    quietly(this.refresh());
    return stopped;
  };
}

/**
 * Needs-you first, then the rest; within a group the service's order (most recent
 * first) is kept. A chat in both lists (its status changed between the two
 * requests) appears once, in the group of its newest known status.
 */
export const mergeAgents = (needsYou: ChatSummary[], running: ChatSummary[]): ChatSummary[] => {
  const all = [...needsYou, ...running];
  const byId = new Map<string, ChatSummary>();
  for (const s of all) byId.set(s.sessionId, s);
  const unique = [...byId.values()];
  return [
    ...unique.filter((s) => s.status === 'needsYou'),
    ...unique.filter((s) => s.status !== 'needsYou'),
  ];
};

export const agents = new AgentsState();
