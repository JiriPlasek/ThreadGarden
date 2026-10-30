// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  /** `PAHUB_API_KEY_ONLY=1` at build time (spec §5.5); read it through `buildFlags`. */
  const __PAHUB_API_KEY_ONLY__: boolean;
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
