import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import SettingsDialog from '../../src/lib/components/SettingsDialog.svelte';
import AppShell from '../../src/lib/components/layout/AppShell.svelte';
import ChatList from '../../src/lib/components/layout/ChatList.svelte';
import {
  SCALE_KEY,
  applyScale,
  clampScale,
  readCachedScale,
  rowPx,
} from '../../src/lib/interface-scale';
import { setup, summary } from '../layout/harness';

const root = document.documentElement;

const persisted = (server: Awaited<ReturnType<typeof setup>>['server']) =>
  server
    .calls('uiState.set')
    .map((c) => c.params as { key: string; value: unknown })
    .filter((p) => p.key === SCALE_KEY)
    .map((p) => p.value);

const zoom = (key: string, code: string) => fireEvent.keyDown(window, { key, code, ctrlKey: true });

describe('interface scale', () => {
  afterEach(() => {
    applyScale(1);
    localStorage.clear();
  });

  it('clamps to 80 %–150 % in 10 % steps', () => {
    expect(clampScale(0.5)).toBe(0.8);
    expect(clampScale(2)).toBe(1.5);
    expect(clampScale(1.1000000001)).toBe(1.1);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it('applies the scale as the root font size on top of the 17 px base', () => {
    applyScale(1.2);
    expect(root.style.fontSize).toBe('127.5%');
    applyScale(1);
    expect(root.style.fontSize).toBe('');
    expect(rowPx(3.25, 1)).toBe(55);
    expect(rowPx(3.25, 1.5)).toBe(83);
  });

  it('Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 change, persist and clamp the scale', async () => {
    const { app, server, context } = await setup();
    render(AppShell, { context });
    expect(app.settings.scale).toBe(1);

    // The webview's own zoom must not react as well.
    expect(await zoom('=', 'Equal')).toBe(false);
    expect(app.settings.scale).toBe(1.1);
    expect(root.style.fontSize).toBe('116.875%');
    await zoom('+', 'Equal');
    expect(app.settings.scale).toBe(1.2);
    for (let i = 0; i < 10; i++) await zoom('=', 'Equal');
    expect(app.settings.scale).toBe(1.5);

    expect(await zoom('0', 'Digit0')).toBe(false);
    expect(app.settings.scale).toBe(1);
    expect(root.style.fontSize).toBe('');

    expect(await zoom('-', 'Minus')).toBe(false);
    expect(app.settings.scale).toBe(0.9);
    for (let i = 0; i < 10; i++) await zoom('-', 'Minus');
    expect(app.settings.scale).toBe(0.8);

    await waitFor(() => expect(persisted(server).at(-1)).toBe(0.8));
    expect(persisted(server)).toContain(1.1);
    // Remembered locally too, for the next start's first paint.
    expect(readCachedScale()).toBe(0.8);
  });

  it('restores the persisted scale at startup', async () => {
    const { app } = await setup((server) => {
      server.handlers['uiState.get'] = (p) => ({
        value: (p as { key: string }).key === SCALE_KEY ? 1.3 : null,
      });
    });
    await app.settings.restoreScale();
    expect(app.settings.scale).toBe(1.3);
    expect(readCachedScale()).toBe(1.3);
  });

  it('ignores a persisted value that is not a number', async () => {
    const { app } = await setup((server) => {
      server.handlers['uiState.get'] = () => ({ value: 'huge' });
    });
    await app.settings.restoreScale();
    expect(app.settings.scale).toBe(1);
  });

  it('the settings dialog changes the interface size', async () => {
    const { app, server, context } = await setup((server) => {
      server.handlers['settings.get'] = () => ({});
    });
    render(SettingsDialog, { context });
    app.interaction.settingsOpen = true;
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    const size = within(dialog).getByLabelText(/interface size/i) as HTMLSelectElement;
    expect(size.value).toBe('1');
    await userEvent.selectOptions(size, '1.2');
    expect(app.settings.scale).toBe(1.2);
    expect(root.style.fontSize).toBe('127.5%');
    await waitFor(() => expect(persisted(server)).toEqual([1.2]));
  });

  it('chat list rows grow with the interface size', async () => {
    const { app, context } = await setup((server) => {
      server.handlers['sessions.list'] = () => ({ items: [summary('a'), summary('b')] });
    });
    app.settings.setScale(1.5);
    render(ChatList, { context });
    const row = (await screen.findAllByRole('option'))[0]!;
    expect(row.parentElement!.style.height).toBe('83px');
  });
});
