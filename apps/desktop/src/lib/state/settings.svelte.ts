import { settingsDefaults, type Settings, type SettingsPatch } from '@pahub/protocol';
import { quietly, type Api } from './api';

export const COLUMNS_KEY = 'columns';
export const COLLAPSED_KEY = 'columns.collapsed';
/** Column widths are written this long after the last change (dragging fires many). */
export const COLUMNS_SAVE_DELAY_MS = 300;
export type ColumnWidths = Record<string, number>;
export type CollapsedColumns = Record<string, boolean>;

export class SettingsState {
  value = $state<Settings>({ ...settingsDefaults });
  loaded = $state(false);
  /** Persisted column widths in px by column name. */
  columnWidths = $state<ColumnWidths>({});
  /** Persisted collapsed flags by column name. */
  collapsed = $state<CollapsedColumns>({});

  private api: Api | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  init = (api: Api): void => {
    this.api = api;
    api.onReconnect(() => this.load());
  };

  load = async (): Promise<void> => {
    if (!this.api) return;
    this.value = await this.api.request('settings.get', {});
    this.loaded = true;
  };

  update = async (patch: SettingsPatch): Promise<void> => {
    if (!this.api) return;
    this.value = await this.api.request('settings.set', patch);
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
