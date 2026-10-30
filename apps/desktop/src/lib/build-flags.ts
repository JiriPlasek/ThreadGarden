/**
 * Build-time configuration, fixed when the UI is built (see `vite.config.ts`).
 * An object rather than bare constants so component tests can try each variant.
 */
export const buildFlags = {
  /**
   * API-key-only build (spec §5.5; `PAHUB_API_KEY_ONLY=1` at build time): chats
   * run only on an Anthropic API key, and the option to inherit the installed
   * Claude Code's sign-in is not offered. The service enforces the same policy.
   */
  apiKeyOnly: __PAHUB_API_KEY_ONLY__,
};
