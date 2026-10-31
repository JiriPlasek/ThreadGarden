/**
 * Every keyboard shortcut (and the few mouse gestures) Threadgarden implements, in
 * one place: the shortcuts dialog, tooltips and the README are written from
 * this list. Each entry must match a real handler (see the component named
 * in its comment); the README test checks every description is documented.
 */

/** macOS shows ⌘ and the other modifier glyphs; Windows and Linux show Ctrl+…. */
export type Platform = 'mac' | 'other';

/**
 * One key of a combination. `Mod` is Ctrl on Windows/Linux and ⌘ on macOS;
 * `Ctrl` is the Control key on every platform. Other names: `Shift`, `Alt`,
 * `Enter`, `Esc`, `Tab`, `Space`, `Delete`, `Home`, `End`, `PageUp`,
 * `PageDown`, `Up`, `Down`, `Left`, `Right`, the mouse gestures `Click`,
 * `MiddleClick` and `DoubleClick`, or a printable character (`K`, `/`, `?`,
 * `@`, `=`, …).
 */
export type Key = string;
export type Combo = readonly Key[];

export const SHORTCUT_GROUPS = [
  'Global',
  'Tabs',
  'Chat list',
  'Composer',
  'Pickers',
  'Interface',
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export type Shortcut = {
  id: string;
  group: ShortcutGroup;
  /** Alternative combinations: any of them does it. */
  combos: readonly Combo[];
  description: string;
  /** Listed only while the composer's "Enter sends the message" setting has this value. */
  enterToSend?: boolean;
};

export const SHORTCUTS: readonly Shortcut[] = [
  // Global — QuickSwitcher, KeyboardShortcutsDialog, TabsBar (new chat), the dialogs.
  {
    id: 'quick-switcher',
    group: 'Global',
    combos: [['Mod', 'K']],
    description: 'Open the quick switcher (chats, projects, messages and commands)',
  },
  {
    id: 'shortcuts',
    group: 'Global',
    combos: [['Mod', '/'], ['?']],
    description: 'Show keyboard shortcuts',
  },
  {
    id: 'new-chat',
    group: 'Global',
    combos: [['Mod', 'N']],
    description: 'Start a new chat (in the selected project)',
  },
  {
    id: 'close-dialog',
    group: 'Global',
    combos: [['Esc']],
    description: 'Close a dialog or menu',
  },

  // Tabs — TabsBar.
  { id: 'tab-close', group: 'Tabs', combos: [['Mod', 'W']], description: 'Close the active tab' },
  {
    id: 'tab-close-click',
    group: 'Tabs',
    combos: [['MiddleClick']],
    description: 'Close the tab under the pointer',
  },
  { id: 'tab-next', group: 'Tabs', combos: [['Ctrl', 'Tab']], description: 'Next tab' },
  {
    id: 'tab-previous',
    group: 'Tabs',
    combos: [['Ctrl', 'Shift', 'Tab']],
    description: 'Previous tab',
  },
  {
    id: 'tab-arrows',
    group: 'Tabs',
    combos: [['Left'], ['Right']],
    description: 'Previous or next tab (focus on a tab)',
  },
  {
    id: 'tab-ends',
    group: 'Tabs',
    combos: [['Home'], ['End']],
    description: 'First or last tab (focus on a tab)',
  },
  {
    id: 'tab-delete',
    group: 'Tabs',
    combos: [['Delete']],
    description: 'Close the focused tab',
  },

  // Chat list — ChatList.
  {
    id: 'list-move',
    group: 'Chat list',
    combos: [['Up'], ['Down']],
    description: 'Move through the chats',
  },
  {
    id: 'list-page',
    group: 'Chat list',
    combos: [['PageUp'], ['PageDown']],
    description: 'Move a page of chats at a time',
  },
  {
    id: 'list-ends',
    group: 'Chat list',
    combos: [['Home'], ['End']],
    description: 'First or last chat',
  },
  {
    id: 'list-open',
    group: 'Chat list',
    combos: [['Enter'], ['Space']],
    description: 'Open the selected chat',
  },
  {
    id: 'list-from-search',
    group: 'Chat list',
    combos: [['Down']],
    description: 'From the search field, go to the list',
  },
  {
    id: 'list-clear-search',
    group: 'Chat list',
    combos: [['Esc']],
    description: 'Clear the search',
  },
  // v1.2 §3 buckets and multi-select — ChatList.
  {
    id: 'list-archive',
    group: 'Chat list',
    combos: [['E']],
    description: 'Archive the selected chats (or the one under the cursor)',
  },
  {
    id: 'list-hold',
    group: 'Chat list',
    combos: [['H']],
    description: 'Put on hold: choose until when and add a note',
  },
  {
    id: 'list-activate',
    group: 'Chat list',
    combos: [['A']],
    description: 'Make active (back from On hold or Archived)',
  },
  {
    id: 'list-select-toggle',
    group: 'Chat list',
    combos: [['Mod', 'Click']],
    description: 'Add a chat to the selection, or remove it',
  },
  {
    id: 'list-select-range',
    group: 'Chat list',
    combos: [['Shift', 'Click']],
    description: 'Select a range of chats',
  },
  {
    id: 'list-select-cursor',
    group: 'Chat list',
    combos: [['Shift', 'Space']],
    description: 'Add the chat under the cursor to the selection, or remove it',
  },
  {
    id: 'list-select-section',
    group: 'Chat list',
    combos: [['Mod', 'A']],
    description: "Select every chat of the cursor's section (else of the first one in view)",
  },
  {
    id: 'list-select-clear',
    group: 'Chat list',
    combos: [['Esc']],
    description: 'Clear the selection',
  },

  // Composer — Composer (send, new line, pickers' triggers, paste), ChatView (Esc), PermissionCard.
  {
    id: 'composer-send',
    group: 'Composer',
    combos: [['Enter']],
    description: 'Send the message (queued while Claude works)',
    enterToSend: true,
  },
  {
    id: 'composer-newline',
    group: 'Composer',
    combos: [['Shift', 'Enter']],
    description: 'New line',
    enterToSend: true,
  },
  {
    id: 'composer-send-mod',
    group: 'Composer',
    combos: [['Mod', 'Enter']],
    description: 'Send the message (queued while Claude works)',
    enterToSend: false,
  },
  {
    id: 'composer-newline-plain',
    group: 'Composer',
    combos: [['Enter'], ['Shift', 'Enter']],
    description: 'New line',
    enterToSend: false,
  },
  {
    id: 'composer-stop',
    group: 'Composer',
    combos: [['Esc']],
    description: 'Stop Claude while it is working',
  },
  {
    id: 'composer-mention',
    group: 'Composer',
    combos: [['@']],
    description: 'Mention a file or folder',
  },
  {
    id: 'composer-command',
    group: 'Composer',
    combos: [['/']],
    description: 'Slash commands (at the start of the message)',
  },
  {
    id: 'composer-paste',
    group: 'Composer',
    combos: [['Mod', 'V']],
    description: 'Paste images, or a file path as a mention',
  },
  {
    id: 'permission-feedback-close',
    group: 'Composer',
    combos: [['Esc']],
    description: 'Close the "Deny with feedback" field of a permission request',
  },

  // Pickers — Composer (the @ and / pickers), QuickSwitcher.
  {
    id: 'picker-move',
    group: 'Pickers',
    combos: [['Up'], ['Down']],
    description: 'Move through the suggestions',
  },
  {
    id: 'picker-pick',
    group: 'Pickers',
    combos: [['Enter'], ['Tab']],
    description: 'Insert the selected file or command',
  },
  {
    id: 'picker-close',
    group: 'Pickers',
    combos: [['Esc']],
    description: 'Close the suggestions',
  },
  {
    id: 'switcher-move',
    group: 'Pickers',
    combos: [['Up'], ['Down']],
    description: 'Quick switcher: move through the results',
  },
  {
    id: 'switcher-choose',
    group: 'Pickers',
    combos: [['Enter']],
    description: 'Quick switcher: open the chat or run the command',
  },

  // Interface — ChatView (Activity panel), AppShell (interface size), Resizable (column dividers).
  {
    id: 'activity-toggle',
    group: 'Interface',
    combos: [['Mod', '.']],
    description: 'Show or hide the Activity panel (agents and background processes)',
  },
  {
    id: 'scale-up',
    group: 'Interface',
    combos: [
      ['Mod', '='],
      ['Mod', '+'],
    ],
    description: 'Larger interface',
  },
  {
    id: 'scale-down',
    group: 'Interface',
    combos: [['Mod', '-']],
    description: 'Smaller interface',
  },
  {
    id: 'scale-reset',
    group: 'Interface',
    combos: [['Mod', '0']],
    description: 'Default interface size',
  },
  {
    id: 'resize-arrows',
    group: 'Interface',
    combos: [['Left'], ['Right']],
    description: 'Narrow or widen a column (focus on its divider; with Shift in bigger steps)',
  },
  {
    id: 'resize-ends',
    group: 'Interface',
    combos: [['Home'], ['End']],
    description: 'Narrowest or widest column (focus on its divider)',
  },
  {
    id: 'resize-reset',
    group: 'Interface',
    combos: [['DoubleClick']],
    description: "Reset a column's width (on its divider)",
  },
];

/** The shortcuts that apply with the given composer setting. */
export const shortcutsFor = (opts: { enterToSend: boolean }): Shortcut[] =>
  SHORTCUTS.filter((s) => s.enterToSend === undefined || s.enterToSend === opts.enterToSend);

/** Looks up a shortcut by id (throws on a typo, so a renamed entry fails loudly in tests). */
export const shortcut = (id: string): Shortcut => {
  const s = SHORTCUTS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut: ${id}`);
  return s;
};

type NavigatorLike = { platform?: string; userAgentData?: { platform?: string } };

/** macOS (or iOS) from `userAgentData.platform`, else `navigator.platform`. */
export const detectPlatform = (nav: NavigatorLike | undefined): Platform => {
  const name = nav?.userAgentData?.platform || nav?.platform || '';
  return /mac|iphone|ipad/i.test(name) ? 'mac' : 'other';
};

/** The platform of this window. */
export const currentPlatform = (): Platform =>
  detectPlatform(typeof navigator === 'undefined' ? undefined : (navigator as NavigatorLike));

const LABELS: Record<Platform, Record<string, string>> = {
  other: { Mod: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift', Alt: 'Alt' },
  mac: { Mod: '⌘', Ctrl: '⌃', Shift: '⇧', Alt: '⌥' },
};

const KEY_LABELS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Click: 'Click',
  MiddleClick: 'Middle-click',
  DoubleClick: 'Double-click',
};

/** A combination as people read it: "Ctrl+Shift+Tab" on Windows/Linux, "⌃⇧Tab" on macOS. */
export const formatShortcut = (keys: Combo, platform: Platform = currentPlatform()): string => {
  const parts = keys.map((k) => LABELS[platform][k] ?? KEY_LABELS[k] ?? k);
  // macOS writes modifier glyphs together with the key: ⌘K, ⇧Enter.
  return parts.join(platform === 'mac' ? '' : '+');
};

/** Every combination of a shortcut, formatted: "Ctrl+/ or ?". */
export const formatCombos = (
  combos: readonly Combo[],
  platform: Platform = currentPlatform(),
): string[] => combos.map((c) => formatShortcut(c, platform));

const ARIA_KEYS: Record<string, string> = {
  Ctrl: 'Control',
  Esc: 'Escape',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
};

const MOUSE = new Set(['Click', 'MiddleClick', 'DoubleClick']);

/** The `aria-keyshortcuts` value: "Control+N" (or "Meta+N" on macOS); alternatives space-separated. */
export const ariaKeyShortcuts = (
  combos: readonly Combo[],
  platform: Platform = currentPlatform(),
): string =>
  combos
    .filter((c) => !c.some((k) => MOUSE.has(k)))
    .map((c) =>
      c
        .map((k) => (k === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Control') : (ARIA_KEYS[k] ?? k)))
        .join('+'),
    )
    .join(' ');
