import { settingsDefaults, type Settings } from '@threadgarden/protocol';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import {
  APPEARANCE_CACHE_KEY,
  DEFAULT_MONO_STACK,
  applyAppearance,
  cacheAppearance,
  codeFontStack,
  readCachedAppearance,
} from '../../src/lib/appearance';
import { SettingsState } from '../../src/lib/state/settings.svelte';
import { setup } from '../layout/harness';

const root = document.documentElement;
const ATTRS = ['data-accent', 'data-dark-style', 'data-light-style', 'data-ui-font'];

const reset = (): void => {
  for (const a of ATTRS) root.removeAttribute(a);
  root.style.removeProperty('--font-mono');
  localStorage.clear();
};

describe('appearance', () => {
  afterEach(reset);

  it('applies the settings as attributes next to data-theme, and the code font as --font-mono', () => {
    applyAppearance({ ...settingsDefaults, accent: 'teal', darkStyle: 'midnight' });
    expect(root.getAttribute('data-accent')).toBe('teal');
    expect(root.getAttribute('data-dark-style')).toBe('midnight');
    expect(root.getAttribute('data-light-style')).toBe('default');
    expect(root.getAttribute('data-ui-font')).toBe('inter');
    expect(root.style.getPropertyValue('--font-mono')).toBe('');

    applyAppearance({ ...settingsDefaults, codeFont: 'Fira Code, Consolas' });
    expect(root.getAttribute('data-accent')).toBe('graphite');
    expect(root.style.getPropertyValue('--font-mono')).toBe(
      `"Fira Code", "Consolas", ${DEFAULT_MONO_STACK}`,
    );
    // Back to the default: the stylesheet's own --font-mono applies again.
    applyAppearance(settingsDefaults);
    expect(root.style.getPropertyValue('--font-mono')).toBe('');
  });

  it('defaults set no override: the default look is the stylesheet as it was', () => {
    applyAppearance(settingsDefaults);
    expect(root.getAttribute('style') ?? '').not.toContain('--font');
  });

  it('a custom code font cannot leave its quoted name', () => {
    expect(codeFontStack('x"; } body { color: red')).toBe(
      `"x body color red", ${DEFAULT_MONO_STACK}`,
    );
    expect(codeFontStack("a'),url(x)")).toBe(`"a", "url x", ${DEFAULT_MONO_STACK}`);
    expect(codeFontStack(' ; ')).toBeNull();
    expect(codeFontStack(null)).toBeNull();
    applyAppearance({ ...settingsDefaults, codeFont: 'Mono"; color: red' });
    expect(root.style.getPropertyValue('color')).toBe('');
  });

  it('remembers the appearance locally, reading each field on its own', () => {
    expect(readCachedAppearance()).toEqual({});
    cacheAppearance({ ...settingsDefaults, theme: 'dark', accent: 'rose', codeFont: 'Iosevka' });
    expect(readCachedAppearance()).toEqual({
      theme: 'dark',
      accent: 'rose',
      darkStyle: 'default',
      lightStyle: 'default',
      uiFont: 'inter',
      codeFont: 'Iosevka',
    });
    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      JSON.stringify({ theme: 'sepia', accent: 'violet', codeFont: 'a;b', idle: 1 }),
    );
    expect(readCachedAppearance()).toEqual({ accent: 'violet', codeFont: 'a b' });
    localStorage.setItem(APPEARANCE_CACHE_KEY, '{not json');
    expect(readCachedAppearance()).toEqual({});
  });

  it('settings start from the remembered appearance and refresh it from the service', async () => {
    cacheAppearance({ ...settingsDefaults, theme: 'dark', accent: 'amber' });
    const state = new SettingsState();
    expect(state.value).toMatchObject({ theme: 'dark', accent: 'amber', notifications: true });

    const env = await setup((server) => {
      server.handlers['settings.get'] = () => ({ ...settingsDefaults, accent: 'green' });
    });
    await env.app.settings.load();
    expect(readCachedAppearance()).toMatchObject({ theme: 'system', accent: 'green' });
  });

  it('fills in defaults when a service sends no appearance fields', async () => {
    const env = await setup((server) => {
      server.handlers['settings.get'] = () => ({ theme: 'light' });
    });
    await env.app.settings.load();
    expect(env.app.settings.value).toMatchObject({ theme: 'light', accent: 'graphite' });
  });
});

describe('settings dialog: appearance', () => {
  afterEach(reset);

  const withSettings = async (initial: Partial<Settings> = {}) => {
    let current: Settings = { ...settingsDefaults, ...initial };
    const env = await setup((server) => {
      server.handlers['settings.get'] = () => current;
      server.handlers['settings.set'] = (p) =>
        (current = { ...current, ...(p as Partial<Settings>) });
    });
    await env.app.settings.load();
    render(SettingsDialog, { context: env.context });
    env.app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    return { ...env, dialog };
  };

  it('saves accent, styles and fonts, sanitising the code font', async () => {
    const { dialog, server, app } = await withSettings();
    const section = within(dialog).getByRole('region', { name: 'Appearance' });
    await userEvent.click(within(section).getByRole('radio', { name: 'Violet' }));
    await userEvent.selectOptions(within(section).getByLabelText('Dark style'), 'dim');
    await userEvent.selectOptions(within(section).getByLabelText('Light style'), 'warm');
    await userEvent.selectOptions(within(section).getByLabelText('Interface font'), 'system');
    await userEvent.type(within(section).getByLabelText('Code font'), 'JetBrains Mono;');
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(server.calls('settings.set')).toHaveLength(1));
    expect(server.calls('settings.set')[0]!.params).toEqual({
      accent: 'violet',
      darkStyle: 'dim',
      lightStyle: 'warm',
      uiFont: 'system',
      codeFont: 'JetBrains Mono',
    });
    expect(app.settings.value).toMatchObject({ accent: 'violet', codeFont: 'JetBrains Mono' });
  });

  it('clearing the code font goes back to the default', async () => {
    const { dialog, server } = await withSettings({ codeFont: 'Fira Code' });
    const input = within(dialog).getByLabelText('Code font') as HTMLInputElement;
    expect(input.value).toBe('Fira Code');
    await userEvent.clear(input);
    await userEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(server.calls('settings.set')).toHaveLength(1));
    expect(server.calls('settings.set')[0]!.params).toEqual({ codeFont: null });
  });

  it('the preview shows the unsaved choice in both themes', async () => {
    const { dialog, server } = await withSettings();
    const light = within(dialog).getByTestId('appearance-preview-light');
    const dark = within(dialog).getByTestId('appearance-preview-dark');
    expect(light.getAttribute('data-theme')).toBe('light');
    expect(dark.getAttribute('data-theme')).toBe('dark');
    expect(light.getAttribute('data-accent')).toBe('graphite');

    await userEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Dark style'), 'midnight');
    await userEvent.type(within(dialog).getByLabelText('Code font'), 'Iosevka');
    await waitFor(() => expect(dark.getAttribute('data-accent')).toBe('teal'));
    expect(dark.getAttribute('data-dark-style')).toBe('midnight');
    expect(light.style.getPropertyValue('--font-mono')).toBe(`"Iosevka", ${DEFAULT_MONO_STACK}`);
    expect(within(light).getByText('Send')).toBeTruthy();
    expect(within(light).getByText('Selected chat')).toBeTruthy();
    // Nothing is saved or applied to the app until Save.
    expect(server.calls('settings.set')).toHaveLength(0);
    expect(root.getAttribute('data-accent')).not.toBe('teal');
  });
});
