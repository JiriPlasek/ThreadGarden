import { settingsDefaults, type Settings, type SettingsPatch } from '@threadgarden/protocol';
import { cacheAppearance, readCachedAppearance } from '../appearance';
import {
  SCALE_KEY,
  SCALE_STEP,
  applyScale,
  cacheScale,
  clampScale,
  readCachedScale,
} from '../interface-scale';
import { apiKey } from '../native';
import { quietly, type Api } from './api';

export const COLUMNS_KEY = 'columns';
export const COLLAPSED_KEY = 'columns.collapsed';
/** `uiState` key of the Activity panel's visibility (spec v1.1 §2). */
export const ACTIVITY_KEY = 'activity.open';
/** Column widths are written this long after the last change (dragging fires many). */
export const COLUMNS_SAVE_DELAY_MS = 300;
export type ColumnWidths = Record<string, number>;
export type CollapsedColumns = Record<string, boolean>;

/** Where Threadgarden's optional API key lives (the OS credential store; a fake in tests). */
export type KeyStore = typeof apiKey;

/** The idle-reclaim setting's range in minutes (0 disables reclaiming). */
export const IDLE_MINUTES_MAX = 1440;

export class SettingsState {
  /**
   * Starts from the appearance this webview remembers (theme, accent, styles,
   * fonts), so the first paint has it; the service's copy replaces it on load.
   */
  value = $state<Settings>({ ...settingsDefaults, ...readCachedAppearance() });
  loaded = $state(false);
  /** Persisted column widths in px by column name. */
  columnWidths = $state<ColumnWidths>({});
  /** Persisted collapsed flags by column name. */
  collapsed = $state<CollapsedColumns>({});
  /**
   * Interface size on top of the 17 px base (`uiState` key `interface.scale`).
   * Starts from the copy this webview remembers, so the first paint has it.
   */
  scale = $state(readCachedScale());

  /**
   * Whether the chat view shows the Activity panel, on every chat (v1.3 §2;
   * narrow panes open it as a drawer on request instead). Remembered in `uiState`.
   */
  activityOpen = $state(true);

  /** An API key is stored (spec §5.5); the key itself never leaves the credential store and the service. */
  hasApiKey = $state(false);

  private api: Api | null = null;
  private keys: KeyStore = apiKey;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  init = (api: Api, keys: KeyStore = apiKey): void => {
    this.api = api;
    this.keys = keys;
    api.onReconnect(() => this.load());
    // The service keeps the key in memory only: hand it over after every hello.
    api.onOpen(() => this.sendStoredKey());
    if (api.status === 'open') quietly(this.sendStoredKey());
  };

  /** Sends the key from the credential store, if any, to the service. */
  sendStoredKey = async (): Promise<void> => {
    const key = await this.keys.get();
    this.hasApiKey = key !== null;
    if (key !== null && this.api) await this.api.request('auth.setApiKey', { key });
  };

  /** Refreshes `hasApiKey` from the credential store. */
  checkApiKey = async (): Promise<void> => {
    this.hasApiKey = (await this.keys.get()) !== null;
  };

  /** Stores the key in the OS credential store, then hands it to the service for new sessions. */
  saveApiKey = async (key: string): Promise<void> => {
    const k = key.trim();
    if (!k) throw new Error('Enter an API key.');
    await this.keys.set(k);
    this.hasApiKey = true;
    await this.api?.request('auth.setApiKey', { key: k });
  };

  /** Removes the key everywhere: new sessions inherit Claude Code's own authentication again. */
  removeApiKey = async (): Promise<void> => {
    await this.keys.clear();
    this.hasApiKey = false;
    await this.api?.request('auth.setApiKey', { key: null });
  };

  load = async (): Promise<void> => {
    if (!this.api) return;
    // Defaults fill in what an older service does not send yet (v1.3 appearance).
    this.value = { ...settingsDefaults, ...(await this.api.request('settings.get', {})) };
    this.loaded = true;
    cacheAppearance(this.value);
  };

  update = async (patch: SettingsPatch): Promise<void> => {
    if (!this.api) return;
    this.value = { ...settingsDefaults, ...(await this.api.request('settings.set', patch)) };
    cacheAppearance(this.value);
  };

  restoreColumns = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: COLUMNS_KEY });
      if (value && typeof value === 'object') {
        const widths: ColumnWidths = {};
        for (const [k, w] of Object.entries(value)) if (typeof w === 'number') widths[k] = w;
        this.columnWidths = widths;
      }
    } catch {
      // Defaults are fine.
    }
    try {
      const { value } = await this.api.request('uiState.get', { key: COLLAPSED_KEY });
      if (value && typeof value === 'object') {
        const flags: CollapsedColumns = {};
        for (const [k, v] of Object.entries(value)) if (typeof v === 'boolean') flags[k] = v;
        this.collapsed = flags;
      }
    } catch {
      // Expanded is fine.
    }
  };

  /** Loads the persisted interface size (the local copy stays when there is none). */
  restoreScale = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: SCALE_KEY });
      if (typeof value === 'number' && Number.isFinite(value)) {
        this.scale = clampScale(value);
        applyScale(this.scale);
        cacheScale(this.scale);
      }
    } catch {
      // The local copy (or 100 %) is fine.
    }
  };

  /** Loads the remembered Activity panel visibility (open when there is none). */
  restoreActivity = async (): Promise<void> => {
    if (!this.api) return;
    try {
      const { value } = await this.api.request('uiState.get', { key: ACTIVITY_KEY });
      if (typeof value === 'boolean') this.activityOpen = value;
    } catch {
      // Open is fine.
    }
  };

  /** Shows or hides the Activity panel and remembers it. */
  setActivityOpen = (open: boolean): void => {
    if (open === this.activityOpen) return;
    this.activityOpen = open;
    if (this.api) quietly(this.api.request('uiState.set', { key: ACTIVITY_KEY, value: open }));
  };

  /** Sets the interface size (clamped to 80 %–150 %), applies it and persists it. */
  setScale = (scale: number): void => {
    const next = clampScale(scale);
    applyScale(next);
    if (next === this.scale) return;
    this.scale = next;
    cacheScale(next);
    if (this.api) quietly(this.api.request('uiState.set', { key: SCALE_KEY, value: next }));
  };

  /** One 10 % step larger (`1`) or smaller (`-1`). */
  stepScale = (direction: 1 | -1): void => this.setScale(this.scale + direction * SCALE_STEP);

  /** Updates a width immediately; the write to the service is debounced. */
  setColumnWidth = (name: string, px: number): void => {
    this.columnWidths = { ...this.columnWidths, [name]: Math.round(px) };
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (!this.api) return;
      quietly(
        this.api.request('uiState.set', { key: COLUMNS_KEY, value: { ...this.columnWidths } }),
      );
    }, COLUMNS_SAVE_DELAY_MS);
  };

  setCollapsed = (name: string, collapsed: boolean): void => {
    this.collapsed = { ...this.collapsed, [name]: collapsed };
    if (this.api) {
      quietly(
        this.api.request('uiState.set', { key: COLLAPSED_KEY, value: { ...this.collapsed } }),
      );
    }
  };
}

export const settings = new SettingsState();
