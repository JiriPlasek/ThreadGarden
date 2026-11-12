import type { ChatSummary, ImageRef, MovePeer, Result } from '@threadgarden/protocol';
import { quietly, type Api } from './api';
import { chatKey, type ChatRef } from './refs';
import type { ComposerDraft } from '#lib/components/composer/tags.js';

/** Drafts are written this long after the last keystroke (spec §7: ≤ 300 ms). */
export const DRAFT_SAVE_DELAY_MS = 300;
/** A draft as stored: the text as it would be sent (pastes expanded) and its tagged images. */
export type SavedDraft = { text: string; images: ImageRef[] };
const EMPTY_DRAFT: SavedDraft = { text: '', images: [] };
/** Same images, same tags: their data strings are shared, so this is cheap. */
const sameImages = (a: readonly ImageRef[], b: readonly ImageRef[]): boolean =>
  a.length === b.length &&
  a.every(
    (x, i) => x.data === b[i]!.data && x.number === b[i]!.number && x.mediaType === b[i]!.mediaType,
  );
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
  /** The phone: the machine whose plug details are being entered (null: none). */
  plugFor = $state<string | null>(null);
  /** A section of the settings dialog to scroll to and focus when it opens (cleared once shown). */
  settingsSection = $state<'machines' | null>(null);
  /** The keyboard shortcuts dialog (Ctrl/Cmd+/ or ?). */
  shortcutsOpen = $state(false);
  /** The user chose to browse history although Claude Code is missing. */
  setupDismissed = $state(false);
  /** A chat whose composer takes focus when it opens (a chat just created). */
  private focusNext: string | null = null;

  private api: Api | null = null;
  private readonly drafts = new Map<string, SavedDraft | (() => SavedDraft)>();
  /** The images the service has for each draft, as far as this window knows. */
  private readonly storedImages = new Map<string, readonly ImageRef[]>();
  private readonly attachments = new Map<string, ComposerDraft>();
  cachedAttachments = (key: string): ComposerDraft | undefined => this.attachments.get(key);
  saveAttachments = (key: string, draft: ComposerDraft): void => {
    this.attachments.set(key, draft);
  };
  moveAttachments = (from: string, to: string): void => {
    const draft = this.attachments.get(from);
    if (draft) this.attachments.set(to, draft);
    this.attachments.delete(from);
  };
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
  cachedDraft = (key: string): SavedDraft | undefined => {
    const value = this.drafts.get(key);
    return typeof value === 'function' ? value() : value;
  };

  /** The saved draft for `key` (local cache first, then `drafts.get`). */
  loadDraft = async (key: string): Promise<SavedDraft> => {
    const cached = this.cachedDraft(key);
    if (cached !== undefined || !this.api) return cached ?? EMPTY_DRAFT;
    const { text, images = [] } = await this.api.request('drafts.get', { key });
    const saved = { text, images };
    if (!this.storedImages.has(key)) this.storedImages.set(key, images);
    // Typing that happened meanwhile wins over the stored draft.
    if (!this.drafts.has(key)) this.drafts.set(key, saved);
    return this.cachedDraft(key) ?? saved;
  };

  /**
   * Remembers the draft now (or how to make it, called when it is read); the
   * write to the service is debounced.
   */
  saveDraft = (key: string, draft: SavedDraft | (() => SavedDraft)): void => {
    this.drafts.set(key, draft);
    clearTimeout(this.draftTimers.get(key));
    this.draftTimers.set(
      key,
      setTimeout(() => this.flushDraft(key), DRAFT_SAVE_DELAY_MS),
    );
  };

  /**
   * Writes a pending draft at once (composer unmount, send). Its images go
   * only when they changed (they can be megabytes, the text is written as it
   * is typed), and with empty text, which without them clears the draft.
   */
  flushDraft = (key: string): void => {
    const timer = this.draftTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.draftTimers.delete(key);
    if (!this.api) return;
    const { text, images } = this.cachedDraft(key) ?? EMPTY_DRAFT;
    const stored = this.storedImages.get(key);
    const changed = stored === undefined || !sameImages(images, stored);
    this.storedImages.set(key, images);
    quietly(
      this.api.request('drafts.set', { key, text, ...(changed || text === '' ? { images } : {}) }),
    );
  };

  clearDraft = (key: string): void => {
    this.attachments.delete(key);
    clearTimeout(this.draftTimers.get(key));
    this.draftTimers.delete(key);
    this.drafts.set(key, EMPTY_DRAFT);
    this.storedImages.set(key, []);
    if (this.api) quietly(this.api.request('drafts.set', { key, text: '', images: [] }));
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
