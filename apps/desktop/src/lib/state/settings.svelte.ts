import { settingsDefaults, type Settings, type SettingsPatch } from '@pahub/protocol';
import { quietly, type Api } from './api';

export const COLUMNS_KEY = 'columns';
export type ColumnWidths = Record<string, number>;

export class SettingsState {
  value = $state<Settings>({ ...settingsDefaults });
  loaded = $state(false);
  /** Persisted column widths in px by column name. */
  columnWidths = $state<ColumnWidths>({});

  private api: Api | null = null;

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
  };

  setColumnWidth = (name: string, px: number): void => {
    this.columnWidths = { ...this.columnWidths, [name]: Math.round(px) };
    if (this.api) {
      quietly(
        this.api.request('uiState.set', { key: COLUMNS_KEY, value: { ...this.columnWidths } }),
      );
    }
  };
}

export const settings = new SettingsState();
