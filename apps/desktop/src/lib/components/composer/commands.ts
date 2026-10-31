/**
 * Slash commands that only exist in Claude Code's terminal UI (ruling R25,
 * spec §6.4). Those with a matching Threadgarden control open it instead of being
 * sent; the others are listed as unavailable with the reason, and typing one
 * shows that notice instead of sending it as text. A command the SDK reports
 * as supported (`chat.commands`) always wins over this table.
 * Source: Claude Code's command reference (code.claude.com/docs/en/commands).
 */
import type { SlashCommand } from '#lib/state/interaction.svelte.js';

/** The chat header pickers a command can open. */
export type Control = 'model' | 'effort' | 'permissionMode';

export type MenuCommand = SlashCommand & {
  /** Opens a Threadgarden control instead of being sent. */
  control?: Control;
  /** Not available in Threadgarden; the reason shown. */
  unavailable?: string;
};

const mapped: MenuCommand[] = [
  {
    name: 'model',
    argumentHint: '',
    description: 'Choose the model (opens the model picker)',
    control: 'model',
  },
  {
    name: 'effort',
    argumentHint: '',
    description: 'Choose the effort level (opens the effort picker)',
    control: 'effort',
  },
  {
    name: 'permissions',
    argumentHint: '',
    description: 'Choose the permission mode (opens the permission mode picker)',
    control: 'permissionMode',
  },
];

const terminalOnly: [name: string, reason: string][] = [
  [
    'config',
    "Claude Code's terminal settings screen; edit settings.json, or Threadgarden's own settings",
  ],
  ['login', 'Sign in by running `claude` in a terminal; Threadgarden uses that sign-in'],
  ['logout', 'Sign out by running `claude` in a terminal'],
  ['doctor', 'Run `claude doctor` in a terminal'],
  ['vim', 'Editor modes belong to the terminal prompt'],
  ['terminal-setup', 'Configures terminal keybindings; not needed in Threadgarden'],
  ['ide', 'IDE integration is a terminal feature'],
  ['resume', "Open the chat from Threadgarden's chat list or Ctrl/Cmd+K instead"],
  ['exit', 'Close the tab, or use End session in the chat header'],
  ['theme', 'Threadgarden follows its own theme setting'],
  ['statusline', 'Threadgarden shows model, context and cost in the chat header'],
  ['status', 'Threadgarden shows version, model and account in the chat header'],
  ['keybindings', "Terminal keyboard shortcuts; Threadgarden's shortcuts are fixed"],
  ['tui', 'Terminal rendering mode'],
  ['focus', 'Terminal view mode'],
  ['scroll-speed', 'Terminal scrolling setting'],
  ['rewind', 'Use "Fork from this message" on a message instead'],
  ['hooks', 'Interactive terminal menu; edit hooks in settings.json'],
  ['mobile', 'Terminal QR code; not available in Threadgarden'],
];

/** The Threadgarden-side table: mapped commands, then terminal-only ones. */
export const LOCAL_COMMANDS: readonly MenuCommand[] = [
  ...mapped,
  ...terminalOnly.map(([name, reason]) => ({
    name,
    argumentHint: '',
    description: reason,
    unavailable: reason,
  })),
];

/** The menu: what the SDK reports first, then table entries it does not report. */
export const menuCommands = (reported: readonly SlashCommand[]): MenuCommand[] => {
  const known = new Set(reported.map((c) => c.name));
  return [...reported, ...LOCAL_COMMANDS.filter((c) => !known.has(c.name))];
};

/**
 * How a message that starts with `/name` is handled locally: the table entry
 * when the SDK does not report `name`, else null (send it).
 */
export const localCommand = (
  text: string,
  reported: readonly SlashCommand[],
): MenuCommand | null => {
  const name = /^\/([^\s/]+)/.exec(text.trim())?.[1];
  if (!name || reported.some((c) => c.name === name)) return null;
  return LOCAL_COMMANDS.find((c) => c.name === name) ?? null;
};

export const unavailableNotice = (c: MenuCommand): string =>
  `/${c.name} is unavailable in Threadgarden: ${c.unavailable ?? ''}`;
