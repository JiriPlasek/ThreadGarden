# Analytics: all tokens and an estimated cost

Approved by the owner on 2026-11-21. A small change; ships in 0.11.0.

## Why

The Claude Code CLI shows a session's tokens and cost. The owner wants the same kind of figure in Analytics:
all the tokens their work used, and a rough dollar estimate, as a metric worth watching. The owner works on a
subscription, so no money moves per message: the dollars are **an estimate at API list prices**, rough on purpose.

## Goals

- A **Tokens** tile: every kind of token in the range (input, output, cache read, cache write). It replaces the
  "Output tokens" tile. Its tooltip gives the split by kind.
- An **Est. cost** tile: `≈ $…`. Its tooltip says the figure is estimated at API list prices and isn't what the plan
  costs, and names any model left out because it has no price.
- A chart, **Estimated cost by model**, beside "Output tokens by model": the same buckets (day or week), the same
  series (the busiest models, then `Other`) and the same colors. Its table view lists each model's tokens by kind
  and its dollars.
- Everything follows the range and project filters at the top of Analytics, as the other charts do.

## Non-goals

- A cost readout per chat, like the CLI's. A possible next step; it goes to the vault's *To decide* note.
- Exact pricing: no long-context surcharges, no batch or regional discounts, no fast-mode prices.
- The real cost of API-key chats (`total_cost_usd`): not used here; one estimate for every chat.

## Anti-goals

- No network call for prices. Threadgarden works offline and without a cloud.
- No dollar figure that pretends to be exact or to be the owner's bill.

## Approaches

- **A) A price table built into the service** (chosen by the owner). Offline and simple; it goes stale when a model
  or price arrives, so it's refreshed in a release now and then. A model without a price still counts its tokens and
  stays out of the dollars, named in the tooltip.
- B) Prices fetched from a public list (LiteLLM's model price file). Always current, but online, a format that can
  change, and it fails offline: too much for a rough figure.
- C) Only the cost Claude Code reports, for API-key chats. Exact but almost always $0 for a subscription.

## Decided

- The tokens are already recorded per session, day and model (`stats_days`: input, output, cache read, cache write);
  no history is read again and `STATS_VERSION` stays.
- The price table is one small module in the service: per model family (Claude's Opus, Sonnet, Haiku, Fable
  generations; Codex's GPT models), USD per million tokens for input, output, cache write and cache read, and the
  date the prices were looked up. Models match by their id (for example `claude-opus-5-5`, Codex's model slugs).
- The service computes the estimate from the rows it already sums and sends it with the rest of `analytics`
  (protocol: the KPI total, cost per bucket and series, cost per model in the totals, and the unpriced models).

## Left to the builder

- The prices themselves: from Anthropic's and OpenAI's published price lists at build time, never from memory;
  the lookup date goes in the module.
- How cache-write tokens are priced when a source has several cache durations (the 5-minute rate is fine).
- Number formatting of dollars (`≈ $1.4K`, cents below $10), matching `format.ts`'s `compact`/`full`.
- Whether `Other` gets a cost (sum of its models' costs) — yes unless all of it is unpriced.
