// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  /** `THREADGARDEN_API_KEY_ONLY=1` at build time (spec §5.5); read it through `buildFlags`. */
  const __THREADGARDEN_API_KEY_ONLY__: boolean;
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    /** Shallow routing: the phone's level (`phone-nav.svelte.ts`), one history entry each. */
    interface PageState {
      phone?: 'places' | 'list' | 'chat';
    }
    // interface Platform {}
  }
}

export {};
