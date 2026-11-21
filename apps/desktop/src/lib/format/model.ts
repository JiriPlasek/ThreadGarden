/** Keep provider routing ids and cached provider prefixes out of model labels. */
export const modelLabel = (name: string): string =>
  name.replace(/^Codex · /, '').replace(/^codex:/, '');
