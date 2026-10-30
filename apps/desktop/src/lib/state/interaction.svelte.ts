import type { Result } from '@pahub/protocol';
import { quietly, type Api } from './api';

/** Drafts are written this long after the last keystroke (spec §7: ≤ 300 ms). */
export const DRAFT_SAVE_DELAY_MS = 300;
/** Draft key of the composer for a new chat in `cwd`. */
export const newChatDraftKey = (cwd: string): string => `new:${cwd}`;

export type SystemStatus = Result<'system.status'>;
export type FileSuggestion = Result<'files.suggest'>[number];
export type SlashCommand = Result<'chat.commands'>[number];
export type ModelChoice = Result<'chat.models'>[number];

/**
 * What the composer, the new-chat dialog and the setup screen need from the
 * service besides a chat itself: drafts (cached here so a remounted composer
 * shows its text at once), `@` file suggestions, slash commands, models and
 * whether Claude Code was found.
 */
export class InteractionState {
  /** `system.status`; null until loaded. */
  status = $state.raw<SystemStatus | null>(null);
  /** The new-chat dialog; `cwd` preselects a project folder. */
  newChat = $state<{ open: boolean; cwd: string | null }>({ open: false, cwd: null });
  /** The Ctrl/Cmd+K quick switcher (spec §6.1). */
  switcherOpen = $state(false);
  /** pahub's settings dialog (spec §6.5). */
  settingsOpen = $state(false);
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

  openNewChat = (cwd: string | null = null): void => {
    this.newChat = { open: true, cwd };
  };

  closeNewChat = (): void => {
    this.newChat = { open: false, cwd: this.newChat.cwd };
  };
}

export const interaction = new InteractionState();
