/**
 * Keeps the local copy of each paired machine fresh while it is connected, so
 * its chats can still be read when it is off or away (away machine spec). The
 * copy lives in the local service (`copies.*`); this only feeds it.
 */
import type { ChatSummary, CopyItem, Project } from '@threadgarden/protocol';
import type { Api } from './api';
import type { MachinesState } from './machines.svelte';
import type { MachineScope, Scopes } from './scope';

/** A burst of changes is saved once, this long after the last. */
const DEBOUNCE_MS = 2_000;
/** The chats a copy keeps (the store caps them too). */
const MAX_CHATS = 500;
const PAGE = 100;
/** Items of a chat's copy. */
const TAIL_ITEMS = 10;
/** How much of a chat is read to find those. */
const OPEN_TAIL = 30;
/** Chats read at the same time. */
const PARALLEL = 2;

const COPY_KINDS = new Set(['user', 'assistantText', 'permissionRequest']);

export type CopySyncDeps = {
  /** The local service, which keeps the copies. */
  local: Pick<Api, 'request'>;
  scopes: Pick<Scopes, 'observe'>;
  machines: Pick<MachinesState, 'get'>;
  debounceMs?: number;
};

export class CopySync {
  private deps: CopySyncDeps | null = null;

  init = (deps: CopySyncDeps): (() => void) => {
    this.deps = deps;
    return deps.scopes.observe((scope) => this.follow(scope), { paired: true });
  };

  private follow = (scope: MachineScope): (() => void) => {
    const { api } = scope;
    const wait = this.deps?.debounceMs ?? DEBOUNCE_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let again = false;
    let stopped = false;
    const away = (): boolean => stopped || api.status !== 'open';

    const run = async (): Promise<void> => {
      if (away()) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await this.copy(scope, away);
      } catch {
        // The machine went away mid-copy, or refused: the next change or connect retries.
      } finally {
        running = false;
      }
      if (again) {
        again = false;
        schedule();
      }
    };
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, wait);
    };
    const cancel = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      again = false;
    };

    const offs = [
      api.onOpen(() => run()),
      api.onStatus((s) => {
        if (s !== 'open') cancel();
      }),
      api.on('sessions.changed', schedule),
      api.on('projects.changed', schedule),
    ];
    void run();
    return () => {
      stopped = true;
      cancel();
      for (const off of offs) off();
    };
  };

  private copy = async (scope: MachineScope, away: () => boolean): Promise<void> => {
    const deps = this.deps;
    if (!deps) return;
    const { api, machineId } = scope;
    const projects = await api.request('projects.list', {});
    const chats = await this.chatsOf(api, projects, away);
    if (away()) return;
    await deps.local.request('copies.saveLists', {
      machineId,
      info: deps.machines.get(machineId)?.info ?? null,
      projects,
      chats,
    });
    const have = await deps.local.request('copies.tails', { machineId });
    const stale = chats.filter((c) => c.lastActivity > (have[c.sessionId] ?? -1));
    // Two at a time: the machine may be a small one, and a copy is not urgent.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < stale.length && !away()) {
        const chat = stale[next++]!;
        await this.copyChat(scope, chat);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  };

  /** Every chat of the machine, the newest 500: there is no place that lists them all, so project by project. */
  private chatsOf = async (
    api: Api,
    projects: Project[],
    away: () => boolean,
  ): Promise<ChatSummary[]> => {
    const all: ChatSummary[] = [];
    for (const p of projects) {
      let cursor: string | undefined;
      do {
        if (away()) return [];
        const page = await api.request('sessions.list', {
          place: { kind: 'project', projectId: p.projectId, include: ['onHold', 'archived'] },
          limit: PAGE,
          cursor,
        });
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
    }
    return all.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_CHATS);
  };

  private copyChat = async (scope: MachineScope, chat: ChatSummary): Promise<void> => {
    const local = this.deps?.local;
    if (!local) return;
    try {
      const opened = await scope.api.request('chat.open', {
        sessionId: chat.sessionId,
        tail: OPEN_TAIL,
      });
      const items = opened.items
        .filter((i) => COPY_KINDS.has(i.kind))
        .slice(-TAIL_ITEMS) as CopyItem[];
      await local.request('copies.saveChat', {
        machineId: scope.machineId,
        sessionId: chat.sessionId,
        summary: opened.summary,
        items,
      });
    } catch {
      // One chat failing (gone, or the link dropped) must not stop the others.
    }
  };
}

export const copySync = new CopySync();
