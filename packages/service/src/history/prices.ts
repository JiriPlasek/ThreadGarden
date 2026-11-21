/**
 * API list prices for a rough cost estimate in Analytics: USD per million
 * tokens. Rough on purpose: no long-context, batch, regional or fast-mode
 * prices; cache writes at the shortest cache's price (Anthropic's 5-minute,
 * OpenAI's 30-minute); Claude Haiku 5.5 at its prices for prompts up to
 * 100,000 tokens.
 *
 * Sources, looked up on `PRICES_CHECKED`:
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI (Codex's models, standard tier, short context):
 *   https://developers.openai.com/api/docs/pricing
 *
 * A model missing here still counts its tokens; it stays out of the dollars.
 */
export const PRICES_CHECKED = '2026-11-21';

export type ModelPrice = { input: number; output: number; cacheWrite: number; cacheRead: number };

type TokenCounts = { input: number; output: number; cacheRead: number; cacheCreation: number };

const p = (input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrice => ({
  input,
  output,
  cacheWrite,
  cacheRead,
});

const TABLE: [string[], ModelPrice][] = [
  [['claude-fable-5-2', 'claude-mythos-5-2'], p(8, 10, 0.2, 40)],
  [['claude-fable-5-1', 'claude-mythos-5-1'], p(10, 12.5, 0.25, 50)],
  [['claude-fable-5', 'claude-mythos-5'], p(10, 12.5, 1, 50)],
  [['claude-opus-5-5'], p(4, 5, 0.2, 20)],
  [
    ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'],
    p(5, 6.25, 0.5, 25),
  ],
  [['claude-opus-4-1', 'claude-opus-4'], p(15, 18.75, 1.5, 75)],
  [['claude-sonnet-5-5'], p(2, 2.5, 0.1, 10)],
  [['claude-sonnet-5'], p(2, 2.5, 0.2, 10)],
  [['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'], p(3, 3.75, 0.3, 15)],
  [['claude-haiku-5-5'], p(0.1, 0.125, 0.01, 0.5)],
  [['claude-haiku-4-5'], p(1, 1.25, 0.1, 5)],
  [['gpt-6.2-astra'], p(8, 10, 0.4, 40)],
  [['gpt-6.2-sol', 'gpt-6.1-sol'], p(2, 2.5, 0.1, 10)],
  [['gpt-6.1-terra'], p(1, 1.25, 0.05, 5)],
  [['gpt-6-astra'], p(10, 12.5, 1, 50)],
  [['gpt-6-sol'], p(2, 2.5, 0.2, 10)],
  [['gpt-6-luna'], p(0.1, 0.125, 0.01, 0.5)],
  [['gpt-5.6-sol'], p(4, 5, 0.4, 20)],
  [['gpt-5.6-terra'], p(2, 2.5, 0.2, 12)],
  [['gpt-5.6-luna'], p(0.2, 0.25, 0.02, 1.2)],
];

const PRICES = new Map(TABLE.flatMap(([keys, price]) => keys.map((k) => [k, price] as const)));

/** A dated snapshot id, `claude-sonnet-4-5-20250929`, is priced as its family. */
const DATED = /^(.+)-\d{8}$/;

/** The model's price, matched exactly or as a dated snapshot of a listed id. */
export const priceOf = (model: string): ModelPrice | undefined =>
  PRICES.get(model) ?? PRICES.get(DATED.exec(model)?.[1] ?? '');

/** The estimated cost in USD, or undefined when the model has no price. */
export const costOf = (model: string, t: TokenCounts): number | undefined => {
  const price = priceOf(model);
  if (!price) return undefined;
  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheRead * price.cacheRead +
      t.cacheCreation * price.cacheWrite) /
    1_000_000
  );
};
