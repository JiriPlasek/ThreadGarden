/** Title selection (spec §5.3). pahub never writes titles back to Claude Code. */
export type TitleParts = {
  customTitle?: string | null;
  sdkTitle?: string | null;
  summary?: string | null;
  firstPrompt?: string | null;
};

export const FIRST_PROMPT_MAX = 80;

const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** Non-custom titles are whitespace-collapsed and cut to 80 chars; a custom title is kept as typed. */
const short = (s: string): string => s.replace(/\s+/g, ' ').slice(0, FIRST_PROMPT_MAX);

/** pahub custom title → SDK title → summary → first prompt. */
export const titleFor = (s: TitleParts): string => {
  const custom = clean(s.customTitle);
  if (custom) return custom;
  const sdk = clean(s.sdkTitle);
  if (sdk) return short(sdk);
  const summary = clean(s.summary);
  if (summary) return short(summary);
  const prompt = clean(s.firstPrompt);
  if (prompt) return short(prompt);
  return 'Untitled chat';
};
