/** Provider-qualified picker values and session ids keep routing independent of model names. */
export const isCodexModel = (model?: string): boolean => model?.startsWith('codex:') === true;
export const isCodexSession = (id: string): boolean => /^codex-[0-9a-f-]{36}$/.test(id);
export const codexModel = (model?: string): string | undefined =>
  model && model !== 'codex:default' ? model.replace(/^codex:/, '') : undefined;
