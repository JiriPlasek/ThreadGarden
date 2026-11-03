import type { ChatSummary, MovePeer, Result } from '@threadgarden/protocol';
import { quietly, type Api } from './api';
import { chatKey, type ChatRef } from './refs';

/** Drafts are written this long after the last keystroke (spec §7: ≤ 300 ms). */
export const DRAFT_SAVE_DELAY_MS = 300;
/** Draft key of the composer for a new chat in `cwd`. */
export const newChatDraftKey = (cwd: string): string => `new:${cwd}`;

export type SystemStatus = Result<'system.status'>;
export type FileSuggestion = Result<'files.suggest'>[number];
export type SlashCommand = Result<'chat.commands'>[number];
export type ModelChoice = Result<'chat.models'>[number];
/** Threadgarden's first note in a moved chat that didn't send (move-chat §6). */
export type PendingNote = { text: string; problem: string };
/**
 * A moved chat whose old copy its source machine still lists: `move.markMoved`
 * failed after the commit (ruling R2). What a retry needs, without the move.
 */
export type PendingMark = {
  /** The machine the chat moved from. */
  source: string;
  exportId: string;
  /** When the move began (just before `move.exportBegin`). */
  begunAt: number;
  to: MovePeer;
  problem: string | null;
};

/**
 * What the composer, the new-chat dialog and the setup screen need from the
 * service besides a chat itself: drafts (cached here so a remounted composer
 * shows its text at once), `@` file suggestions, slash commands, models and
 * whether Claude Code was found.
 */
export class InteractionState {
  /** `system.status`; null until loaded. */
  status = $state.raw<SystemStatus | null>(null);
  /**
   * The new-chat dialog; `cwd` preselects a project folder of `machineId`'s
   * (null: the selected project's machine, else This PC).
   */
  newChat = $state<{ open: boolean; cwd: string | null; machineId: string | null }>({
    open: false,
    cwd: null,
    machineId: null,
  });
  /**
   * The Move to… dialog (move-chat §3), for the chat `ref`; `summary` names a
   * chat that is not open (from its row or the switcher).
   */
  moveChat = $state<{ open: boolean; ref: ChatRef | null; summary: ChatSummary | null }>({
    open: false,
    ref: null,
    summary: null,
  });
  /**
   * First notes of moved chats that didn't send, by the chat's key on its new
   * machine: the chat there shows them with Send again, dialog or not.
   */
  pendingNotes = $state<Record<string, PendingNote>>({});
  /**
   * Moved chats whose old copy is still shown on their source, by the chat's
   * key on its new machine: the chat there offers Retry, dialog or not.
   */
  pendingMarks = $state<Record<string, PendingMark>>({});
  /** What a move said about a chat after it was over (e.g. it stayed after all), by chat key. */
  moveNotices = $state<Record<string, string>>({});
  /** The Ctrl/Cmd+K quick switcher (spec §6.1). */
  switcherOpen = $state(false);
  /** Threadgarden's settings dialog (spec §6.5). */
  settingsOpen = $state(false);
  /** The Add machine dialog (Settings → Machines). */
  addMachineOpen = $state(false);
  /** A section of the settings dialog to scroll to and focus when it opens (cleared once shown). */
  settingsSection = $state<'machines' | null>(null);
  /** The keyboard shortcuts dialog (Ctrl/Cmd+/ or ?). */
  shortcutsOpen = $state(false);
  /** The user chose to browse history although Claude Code is missing. */
  setupDismissed = $state(false);
  /** A chat whose composer takes focus when it opens (a chat just created). */
  private focusNext: string | null = null;

  private api: Api | null = null;
  private readonly drafts = new Map<string, string>();
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly commandCache = new Map<string, Promise<SlashCommand[]>>();

  init = (api: Api): void => {
    this.api = api;
    api.onOpen(() => this.loadStatus());
    if (api.status === 'open') quietly(this.loadStatus());
  };

  /** True when the service reports no usable Claude Code (setup screen, spec §6.4). */
  get claudeMissing(): boolean {
    return this.status !== null && !this.status.claude.found;
  }

  loadStatus = async (): Promise<void> => {
    if (!this.api) return;
    this.status = await this.api.request('system.status', {});
  };

  // ── drafts ──────────────────────────────────────────────────────────────

  /** The draft known locally (no request); undefined when it has to be fetched. */
  cachedDraft = (key: string): string | undefined => this.drafts.get(key);

  /** The saved draft for `key` (local cache first, then `drafts.get`). */
  loadDraft = async (key: string): Promise<string> => {
    const cached = this.drafts.get(key);
    if (cached !== undefined || !this.api) return cached ?? '';
    const { text } = await this.api.request('drafts.get', { key });
    // Typing that happened meanwhile wins over the stored draft.
    if (!this.drafts.has(key)) this.drafts.set(key, text);
    return this.drafts.get(key) ?? text;
  };

  /** Remembers the draft now; the write to the service is debounced. */
  saveDraft = (key: string, text: string): void => {
    this.drafts.set(key, text);
    clearTimeout(this.draftTimers.get(key));
    this.draftTimers.set(
      key,
      setTimeout(() => this.flushDraft(key), DRAFT_SAVE_DELAY_MS),
    );
  };

  /** Writes a pending draft at once (composer unmount, send). */
  flushDraft = (key: string): void => {
    const timer = this.draftTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.draftTimers.delete(key);
    if (this.api) {
      quietly(this.api.request('drafts.set', { key, text: this.drafts.get(key) ?? '' }));
    }
  };

  clearDraft = (key: string): void => {
    clearTimeout(this.draftTimers.get(key));
    this.draftTimers.delete(key);
    this.drafts.set(key, '');
    if (this.api) quietly(this.api.request('drafts.set', { key, text: '' }));
  };

  // ── lookups ─────────────────────────────────────────────────────────────

  suggestFiles = async (cwd: string, query: string, limit = 20): Promise<FileSuggestion[]> => {
    if (!this.api) return [];
    return this.api.request('files.suggest', { cwd, query, limit });
  };

  /** Slash commands for a chat (or a folder, for new chats); fetched once per scope. */
  commands = (scope: { sessionId?: string; cwd?: string }): Promise<SlashCommand[]> => {
    if (!this.api) return Promise.resolve([]);
    const key = scope.sessionId ? `s:${scope.sessionId}` : `c:${scope.cwd ?? ''}`;
    let hit = this.commandCache.get(key);
    if (!hit) {
      hit = this.api.request('chat.commands', scope);
      // A failure or an empty answer (no process has reported commands yet) is retried next time.
      hit.then(
        (list) => {
          if (list.length === 0) this.commandCache.delete(key);
        },
        () => this.commandCache.delete(key),
      );
      this.commandCache.set(key, hit);
    }
    return hit;
  };

  models = async (cwd: string): Promise<ModelChoice[]> => {
    if (!this.api) return [];
    return this.api.request('chat.models', { cwd });
  };

  // ── new chat ────────────────────────────────────────────────────────────

  /** Asks the next view of `sessionId` to focus its composer. */
  focusComposer = (sessionId: string): void => {
    this.focusNext = sessionId;
  };

  /** True once for the chat named by `focusComposer`. */
  takeComposerFocus = (sessionId: string): boolean => {
    if (this.focusNext !== sessionId) return false;
    this.focusNext = null;
    return true;
  };

  openNewChat = (cwd: string | null = null, machineId: string | null = null): void => {
    this.newChat = { open: true, cwd, machineId };
  };

  closeNewChat = (): void => {
    this.newChat = { ...this.newChat, open: false };
  };

  // ── move a chat ─────────────────────────────────────────────────────────

  openMoveChat = (ref: ChatRef, summary: ChatSummary | null = null): void => {
    this.moveChat = {
      open: true,
      ref: { machineId: ref.machineId, sessionId: ref.sessionId },
      summary,
    };
  };

  closeMoveChat = (): void => {
    this.moveChat = { ...this.moveChat, open: false };
  };

  notePending = (ref: ChatRef, note: PendingNote): void => {
    this.pendingNotes = { ...this.pendingNotes, [chatKey(ref)]: note };
  };

  noteSent = (ref: ChatRef): void => {
    this.pendingNotes = without(this.pendingNotes, chatKey(ref));
  };

  markPending = (ref: ChatRef, mark: PendingMark): void => {
    this.pendingMarks = { ...this.pendingMarks, [chatKey(ref)]: mark };
  };

  markDone = (ref: ChatRef): void => {
    this.pendingMarks = without(this.pendingMarks, chatKey(ref));
  };

  moveNotice = (ref: ChatRef, text: string): void => {
    this.moveNotices = { ...this.moveNotices, [chatKey(ref)]: text };
  };

  dismissMoveNotice = (ref: ChatRef): void => {
    this.moveNotices = without(this.moveNotices, chatKey(ref));
  };
}

/** `record` without `key` (the same object when it has none: no needless update). */
const without = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
};

export const interaction = new InteractionState();
