/**
 * The phone's one-column navigation: machines and places, then a place's
 * chats, then a chat. Each level down is a history entry, so Android's back
 * gesture (the webview going back, as Tauri does by default) moves up one
 * level, and leaves the app only from the top. The history it uses is bound
 * by the page (SvelteKit's shallow routing); until then, and in tests, an
 * in-memory one stands in.
 */

export type PhoneLevel = 'places' | 'list' | 'chat';

const LEVELS: readonly PhoneLevel[] = ['places', 'list', 'chat'];
const depth = (level: PhoneLevel): number => LEVELS.indexOf(level);

/** Where the levels are kept: `push` adds an entry, `back` goes back `steps` entries. */
export type PhoneHistory = {
  push(level: PhoneLevel): void;
  back(steps: number): void;
};

export class PhoneNavState {
  /** The level on screen. */
  level = $state<PhoneLevel>('places');

  private history: PhoneHistory;

  constructor() {
    // In memory: going back shows the level above at once.
    const stack: PhoneLevel[] = [];
    this.history = {
      push: (level) => void stack.push(level),
      back: (steps) => {
        stack.splice(Math.max(0, stack.length - steps));
        this.level = stack.at(-1) ?? 'places';
      },
    };
  }

  /** Uses the page's history from now on (the levels already shown stay). */
  bind = (history: PhoneHistory): void => {
    this.history = history;
  };

  /**
   * Shows `to`: one entry per level down, so Back retraces each (a chat opened
   * from the places, say from search, still goes back to its list first).
   * Going up goes back in the history, as Back would.
   */
  go = (to: PhoneLevel): void => {
    const from = depth(this.level);
    const target = depth(to);
    if (target < from) {
      this.history.back(from - target);
      return;
    }
    for (let d = from + 1; d <= target; d++) this.history.push(LEVELS[d]!);
    this.level = to;
  };

  /** One level up (the on-screen back button). */
  up = (): void => {
    if (this.level !== 'places') this.history.back(1);
  };

  /** The history moved by itself (Back): shows the level it holds. */
  shown = (level: PhoneLevel | undefined): void => {
    this.level = level ?? 'places';
  };
}

export const phoneNav = new PhoneNavState();
