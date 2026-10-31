import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_GROUPS,
  SHORTCUTS,
  ariaKeyShortcuts,
  detectPlatform,
  formatShortcut,
  shortcutsFor,
} from '../../src/lib/shortcuts';

describe('shortcut formatting', () => {
  it('uses Ctrl and + on Windows and Linux', () => {
    expect(formatShortcut(['Mod', 'K'], 'other')).toBe('Ctrl+K');
    expect(formatShortcut(['Ctrl', 'Shift', 'Tab'], 'other')).toBe('Ctrl+Shift+Tab');
    expect(formatShortcut(['Mod', 'Enter'], 'other')).toBe('Ctrl+Enter');
    expect(formatShortcut(['Esc'], 'other')).toBe('Esc');
    expect(formatShortcut(['Up'], 'other')).toBe('↑');
    expect(formatShortcut(['MiddleClick'], 'other')).toBe('Middle-click');
  });

  it('uses the macOS modifier glyphs, written together', () => {
    expect(formatShortcut(['Mod', 'K'], 'mac')).toBe('⌘K');
    expect(formatShortcut(['Ctrl', 'Shift', 'Tab'], 'mac')).toBe('⌃⇧Tab');
    expect(formatShortcut(['Mod', 'Enter'], 'mac')).toBe('⌘Enter');
    expect(formatShortcut(['Shift', 'Enter'], 'mac')).toBe('⇧Enter');
    expect(formatShortcut(['Esc'], 'mac')).toBe('Esc');
  });

  it('names keys for aria-keyshortcuts per platform', () => {
    expect(ariaKeyShortcuts([['Mod', 'N']], 'other')).toBe('Control+N');
    expect(ariaKeyShortcuts([['Mod', 'N']], 'mac')).toBe('Meta+N');
    expect(ariaKeyShortcuts([['Esc']], 'other')).toBe('Escape');
    expect(ariaKeyShortcuts([['Mod', '/'], ['?']], 'other')).toBe('Control+/ ?');
    // Mouse gestures have no key name.
    expect(ariaKeyShortcuts([['MiddleClick']], 'other')).toBe('');
  });

  it('detects macOS from userAgentData or navigator.platform', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ platform: '', userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('other');
    expect(detectPlatform({ platform: 'Linux x86_64' })).toBe('other');
    expect(detectPlatform(undefined)).toBe('other');
  });
});

describe('shortcut list', () => {
  it('has every group, each entry in a known group with a unique id', () => {
    expect(SHORTCUT_GROUPS).toEqual([
      'Global',
      'Tabs',
      'Chat list',
      'Composer',
      'Pickers',
      'Interface',
    ]);
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHORTCUTS) {
      expect(SHORTCUT_GROUPS).toContain(s.group);
      expect(s.combos.length).toBeGreaterThan(0);
    }
    for (const g of SHORTCUT_GROUPS) expect(SHORTCUTS.some((s) => s.group === g)).toBe(true);
  });

  it('lists the composer keys that match the "Enter sends" setting', () => {
    const send = (enterToSend: boolean) =>
      shortcutsFor({ enterToSend })
        .filter((s) => s.id.startsWith('composer-send'))
        .map((s) => s.combos.map((c) => formatShortcut(c, 'other')));
    expect(send(true)).toEqual([['Enter']]);
    expect(send(false)).toEqual([['Ctrl+Enter']]);
    const newline = (enterToSend: boolean) =>
      shortcutsFor({ enterToSend })
        .filter((s) => s.id.startsWith('composer-newline'))
        .map((s) => s.combos.map((c) => formatShortcut(c, 'other')));
    expect(newline(true)).toEqual([['Shift+Enter']]);
    expect(newline(false)).toEqual([['Enter', 'Shift+Enter']]);
  });

  it('includes the interface size keys', () => {
    const iface = SHORTCUTS.filter((s) => s.group === 'Interface').flatMap((s) =>
      s.combos.map((c) => formatShortcut(c, 'other')),
    );
    expect(iface).toEqual(expect.arrayContaining(['Ctrl+=', 'Ctrl++', 'Ctrl+-', 'Ctrl+0']));
  });

  it('includes the Activity panel toggle', () => {
    const s = SHORTCUTS.find((x) => x.id === 'activity-toggle');
    expect(s?.combos.map((c) => formatShortcut(c, 'other'))).toEqual(['Ctrl+.']);
    expect(s?.combos.map((c) => formatShortcut(c, 'mac'))).toEqual(['⌘.']);
  });

  it('includes the bucket keys and multi-select gestures of the chat list (v1.2 §3)', () => {
    const list = SHORTCUTS.filter((s) => s.group === 'Chat list');
    const keys = (id: string) =>
      list.find((s) => s.id === id)?.combos.map((c) => formatShortcut(c, 'other'));
    expect(keys('list-archive')).toEqual(['E']);
    expect(keys('list-hold')).toEqual(['H']);
    expect(keys('list-activate')).toEqual(['A']);
    expect(keys('list-select-toggle')).toEqual(['Ctrl+Click']);
    expect(keys('list-select-range')).toEqual(['Shift+Click']);
    expect(keys('list-select-section')).toEqual(['Ctrl+A']);
    expect(keys('list-select-clear')).toEqual(['Esc']);
    expect(formatShortcut(['Mod', 'Click'], 'mac')).toBe('⌘Click');
    // Clicks are not keys.
    expect(ariaKeyShortcuts([['Mod', 'Click']], 'other')).toBe('');
  });

  it('README lists every shortcut description', () => {
    // Tests run in apps/desktop; the README is the repository's.
    const readme = readFileSync(resolve(process.cwd(), '../../README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Keyboard shortcuts'));
    expect(section.startsWith('## Keyboard shortcuts')).toBe(true);
    const missing = SHORTCUTS.filter((s) => !section.includes(s.description)).map(
      (s) => s.description,
    );
    expect(missing).toEqual([]);
  });
});
