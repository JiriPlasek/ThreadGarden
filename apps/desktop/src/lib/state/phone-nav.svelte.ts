/**
 * The phone's one-column navigation: machines and places, then a place's
 * chats, then a chat. Each level down is a history entry, so Android's back
 * gesture (the webview going back, as Tauri does by default) moves up one
 * level, and leaves the app only from the top. An open dialog has an entry of
 * its own: Back closes it and leaves the level alone. The history it uses is
 * bound by the page (SvelteKit's shallow routing); until then, and in tests,
 * an in-memory one stands in.
 */

export type PhoneLevel = 'places' | 'list' | 'chat';

const LEVELS: readonly PhoneLevel[] = ['places', 'list', 'chat'];
const depth = (level: PhoneLevel): number => LEVELS.indexOf(level);

/**
 * Where the levels are kept: `push` adds an entry (`dialog`: one for an open
 * dialog), `replace` replaces the current one, `back` goes back `steps`
 * entries. Each takes effect after the ones before it.
 */
export type PhoneHistory = {
  push(level: PhoneLevel, o?: { dialog?: boolean }): void;
  replace(level: PhoneLevel): void;
  back(steps: number): void;
};

export class PhoneNavState {
  /** The level on screen. */
  level = $state<PhoneLevel>('places');

  private history: PhoneHistory;
  /** An open dialog has its entry on top of the level's. */
  private dialogEntry = false;
  /** Closes the open dialogs (set by the shell). */
  private closeDialogs: () => void = () => {};

  constructor() {
    // In memory: going back shows the entry below at once.
    const stack: { level: PhoneLevel; dialog: boolean }[] = [];
    this.history = {
      push: (level, o) => void stack.push({ level, dialog: o?.dialog === true }),
      replace: (level) => {
        stack.pop();
        stack.push({ level, dialog: false });
      },
      back: (steps) => {
        stack.splice(Math.max(0, stack.length - steps));
        this.popped(stack.at(-1)?.level);
      },
    };
  }

  /** Uses the page's history from now on (the levels already shown stay). */
  bind = (history: PhoneHistory): void => {
    this.history = history;
  };

  /** How Back closes the open dialogs (the shell's). */
  onCloseDialogs = (close: () => void): void => {
    this.closeDialogs = close;
  };

  /**
   * Shows `to`: one entry per level down, so Back retraces each (a chat opened
   * from the places, say from search, still goes back to its list first).
   * Going up goes back in the history, as Back would. A dialog's entry, when
   * one is open (New chat starting a chat), becomes the first level's.
   */
  go = (to: PhoneLevel): void => {
    const from = depth(this.level);
    const target = depth(to);
    const dialog = this.dialogEntry;
    this.dialogEntry = false;
    if (target < from) {
      this.history.back(from - target + (dialog ? 1 : 0));
      return;
    }
    if (target === from) {
      if (dialog) this.history.back(1);
      return;
    }
    for (let d = from + 1; d <= target; d++) {
      if (dialog && d === from + 1) this.history.replace(LEVELS[d]!);
      else this.history.push(LEVELS[d]!);
    }
    this.level = to;
  };

  /** One level up (the on-screen back button). */
  up = (): void => {
    if (this.level !== 'places') this.go(LEVELS[depth(this.level) - 1]!);
  };

  /** A dialog opened: Back closes it first. */
  dialogOpened = (): void => {
    if (this.dialogEntry) return;
    this.dialogEntry = true;
    this.history.push(this.level, { dialog: true });
  };

  /** The dialogs closed by themselves (their X, Escape, a choice): their entry goes. */
  dialogClosed = (): void => {
    if (!this.dialogEntry) return;
    this.dialogEntry = false;
    this.history.back(1);
  };

  /**
   * The history went back (Back): with a dialog open, the dialog closes and
   * the level stays; else the level shown is the one the history holds.
   */
  popped = (level: PhoneLevel | undefined): void => {
    if (this.dialogEntry) {
      this.dialogEntry = false;
      this.closeDialogs();
      return;
    }
    this.level = level ?? 'places';
  };
}

export const phoneNav = new PhoneNavState();
