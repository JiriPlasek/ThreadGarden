import type { ChatStatus, ChatSummary } from '@pahub/protocol';
import { quietly, type Api } from './api';

/** More agents than this at once is not a realistic workload; the strip shows what fits. */
export const AGENTS_LIMIT = 200;

/**
 * Every running agent across all projects (spec §6.1 bottom strip, Ruling R21):
 * every live pahub chat (needs you, working, idle) plus external sessions that
 * need the user or are working, ordered needs-you → working → idle.
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
    api.on('chat.status', (e) => {
      const cur = this.items.find((s) => s.sessionId === e.sessionId);
      // Header-only events (cost, model, …) do not change the strip.
      if (
        cur ? cur.status === e.status && cur.waitingFor === e.waitingFor : e.status === 'history'
      ) {
        return;
      }
      refresh();
    });
    api.onOpen(() => this.refresh());
    if (api.status === 'open') refresh();
  };

  /** Re-fetches the lists; overlapping calls coalesce into one trailing fetch. */
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
          // "Needs you" and "Running" span every project (hidden ones too); the first
          // page of "All chats" starts with every live and external session, which
          // is where idle live chats come from.
          const [needsYou, running, all] = await Promise.all([
            api.request('sessions.list', { place: { kind: 'needsYou' }, limit: AGENTS_LIMIT }),
            api.request('sessions.list', { place: { kind: 'running' }, limit: AGENTS_LIMIT }),
            api.request('sessions.list', { place: { kind: 'all' }, limit: 1 }),
          ]);
          this.items = mergeAgents([...needsYou.items, ...running.items, ...all.items]);
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

const GROUP: Partial<Record<ChatStatus, number>> = { needsYou: 0, working: 1, idle: 2 };

/** Belongs in the strip: live pahub chats that are not paused or failed, external ones that need you or work. */
const isAgent = (s: ChatSummary): boolean =>
  s.external ? s.status === 'needsYou' || s.status === 'working' : s.live && s.status in GROUP;

/**
 * The strip's rows: each chat once (the last report wins, the lists may race a
 * status change), grouped needs-you → working → idle, otherwise in the
 * service's order (most recent first).
 */
export const mergeAgents = (lists: ChatSummary[]): ChatSummary[] => {
  const byId = new Map<string, ChatSummary>();
  for (const s of lists) byId.set(s.sessionId, s);
  return [...byId.values()]
    .filter(isAgent)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => GROUP[a.s.status]! - GROUP[b.s.status]! || a.i - b.i)
    .map(({ s }) => s);
};

export const agents = new AgentsState();
