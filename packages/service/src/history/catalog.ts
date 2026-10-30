/** Title selection (spec §5.3). pahub never writes titles back to Claude Code. */
export type TitleParts = {
  customTitle?: string | null;
  sdkTitle?: string | null;
  summary?: string | null;
  firstPrompt?: string | null;
};

export const FIRST_PROMPT_MAX = 80;

const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** pahub custom title → SDK title → summary → first prompt (whitespace collapsed, ≤ 80 chars). */
export const titleFor = (s: TitleParts): string => {
  const custom = clean(s.customTitle);
  if (custom) return custom;
  const sdk = clean(s.sdkTitle);
  if (sdk) return sdk;
  const summary = clean(s.summary);
  if (summary) return summary;
  const prompt = clean(s.firstPrompt).replace(/\s+/g, ' ');
  if (prompt) return prompt.slice(0, FIRST_PROMPT_MAX);
  return 'Untitled chat';
};
