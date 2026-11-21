# Analytics: all tokens and an estimated cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analytics shows every token used and a rough dollar estimate at API list prices, as tiles and a cost-by-model chart.

**Architecture:** A price table module in the service prices the per-day, per-model token sums `queryAnalytics` already makes; the result travels in `analytics.get` (new fields in the protocol); `AnalyticsView` shows a Tokens tile, an Est. cost tile and an "Estimated cost by model" chart reusing `ColumnChart`, `ChartCard` and `DataTable`.

**Tech Stack:** TypeScript, zod (protocol), node:sqlite (service), Svelte 5 + Tailwind (desktop), vitest.

**Spec:** `docs/superpowers/specs/2026-11-21-analytics-tokens-cost-design.md`

## Global Constraints

- Prices are API list prices in USD per million tokens, looked up 2026-11-21 (Anthropic: platform.claude.com/docs/en/about-claude/pricing; OpenAI: developers.openai.com/api/docs/pricing, standard tier, short context). Never from memory.
- No network call for prices; no long-context, batch, regional or fast-mode adjustments.
- A model without a price still counts its tokens; it is left out of every dollar figure and named in `unpricedModels`.
- Cache writes use the shortest cache's write price (Anthropic 5-minute, OpenAI 30-minute).
- `STATS_VERSION` stays 1: no history is read again.
- Analytics is desktop-only (`analytics.init` is skipped on the phone), so new protocol fields are required, not optional.
- Run pnpm with `--config.verify-deps-before-run=false` (see the no-links recipe in memory); commits carry no Claude attribution.

## Review Focus

1. A Claude id with a date suffix (`claude-sonnet-4-5-20250929`) gets its family's price — Task 1 test `dated ids`.
2. `claude-opus-5` must not take `claude-opus-5-5`'s price, nor `claude-fable-5` take `claude-fable-5-1`'s — Task 1 test `no prefix collisions`.
3. `unknown`, `<synthetic>`-like and unlisted ids (`claude-3-5-sonnet-…`, `gpt-4o`) are unpriced, excluded and listed once each — Task 2 test `unpriced models`.
4. `Other` (models after the fourth) costs the sum of its priced members — Task 2 test `Other's cost`.
5. A range with tokens but only unpriced models shows `—` for cost, not `$0` — Task 3 test `cost tile without prices`.

---

### Task 1: The price table

**Files:**
- Create: `packages/service/src/history/prices.ts`
- Test: `packages/service/test/history/prices.test.ts`

**Interfaces:**
- Produces:
  - `export const PRICES_CHECKED = '2026-11-21';`
  - `export type ModelPrice = { input: number; output: number; cacheWrite: number; cacheRead: number };` (USD per million tokens)
  - `export const priceOf = (model: string): ModelPrice | undefined`
  - `export const costOf = (model: string, t: { input: number; output: number; cacheRead: number; cacheCreation: number }): number | undefined` (USD; undefined when unpriced)

Matching: an entry's key matches a model id that equals the key or is the key followed by `-` and 8 digits (a date). Codex slugs match exactly. No other prefix matching.

Table (input / cacheWrite / cacheRead / output):

| Keys | in | write | read | out |
|---|---|---|---|---|
| `claude-fable-5-2`, `claude-mythos-5-2` | 8 | 10 | 0.20 | 40 |
| `claude-fable-5-1`, `claude-mythos-5-1` | 10 | 12.50 | 0.25 | 50 |
| `claude-fable-5`, `claude-mythos-5` | 10 | 12.50 | 1 | 50 |
| `claude-opus-5-5` | 4 | 5 | 0.20 | 20 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5` | 5 | 6.25 | 0.50 | 25 |
| `claude-opus-4-1`, `claude-opus-4` | 15 | 18.75 | 1.50 | 75 |
| `claude-sonnet-5-5` | 2 | 2.50 | 0.10 | 10 |
| `claude-sonnet-5` | 2 | 2.50 | 0.20 | 10 |
| `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4` | 3 | 3.75 | 0.30 | 15 |
| `claude-haiku-5-5` (≤100K prompt prices) | 0.10 | 0.125 | 0.01 | 0.50 |
| `claude-haiku-4-5` | 1 | 1.25 | 0.10 | 5 |
| `gpt-6.2-astra` | 8 | 10 | 0.40 | 40 |
| `gpt-6.2-sol`, `gpt-6.1-sol` | 2 | 2.50 | 0.10 | 10 |
| `gpt-6.1-terra` | 1 | 1.25 | 0.05 | 5 |
| `gpt-6-astra` | 10 | 12.50 | 1 | 50 |
| `gpt-6-sol` | 2 | 2.50 | 0.20 | 10 |
| `gpt-6-luna` | 0.10 | 0.125 | 0.01 | 0.50 |
| `gpt-5.6-sol` | 4 | 5 | 0.40 | 20 |
| `gpt-5.6-terra` | 2 | 2.50 | 0.20 | 12 |
| `gpt-5.6-luna` | 0.20 | 0.25 | 0.02 | 1.20 |

- [ ] **Step 1: Write the failing tests** in `prices.test.ts`:
  - `prices every family` — `priceOf('claude-opus-5-5')` equals `{ input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }`; `priceOf('gpt-6.2-sol')` equals `{ input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }`.
  - `dated ids` — `priceOf('claude-sonnet-4-5-20250929')` equals `priceOf('claude-sonnet-4-5')`; `priceOf('claude-opus-4-20250514')?.input` is 15.
  - `no prefix collisions` — `priceOf('claude-opus-5')?.input` is 5 and `priceOf('claude-opus-5-5')?.input` is 4; `priceOf('claude-fable-5')?.cacheRead` is 1 and `priceOf('claude-fable-5-1')?.cacheRead` is 0.25; `priceOf('claude-opus-5-9')` is undefined.
  - `unknown ids` — undefined for `''`, `'unknown'`, `'<synthetic>'`, `'claude-3-5-sonnet-20241022'`, `'gpt-4o'`, `'codex:gpt-6.2-sol'`.
  - `costOf` — `costOf('claude-opus-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 10_000_000, cacheCreation: 2_000_000 })` is `4 + 20 + 2 + 10` = `36`; `costOf('unknown', …)` is undefined.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/history/prices.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement `prices.ts`** with the table above (one array of `[keys, price]` turned into a `Map` once), the date-suffix rule, and a header comment naming both sources and `PRICES_CHECKED`.
- [ ] **Step 4: Run the test** — expect PASS.
- [ ] **Step 5: Commit** `feat(service): a price table for a rough cost of tokens`.

### Task 2: Cost and all tokens in `analytics.get`

**Files:**
- Modify: `packages/protocol/src/analytics.ts` (the `kpis` and `tokens` objects)
- Modify: `packages/service/src/history/analytics.ts:154-292` (the per-day pass, `tokens by model`, the return)
- Modify: `packages/service/src/testing/mock-main.ts` only if its fake history has no priced model (give its fake models real ids, e.g. `claude-opus-5-5`, so e2e and screenshots show a cost)
- Test: `packages/service/test/history/analytics.test.ts`, `packages/protocol/test/schemas.test.ts` if it has an analytics fixture

**Interfaces:**
- Consumes: `costOf`, `priceOf` from Task 1.
- Produces (protocol, all required):
  - `kpis.tokens: count` — input + output + cache read + cache write in the range.
  - `kpis.estimatedCostUsd: z.number().nonnegative()` — sum over priced models.
  - `kpis.unpricedModels: z.array(z.string())` — models with tokens in the range and no price, sorted.
  - `tokens.totals[].costUsd: z.number().nonnegative().nullable()` — null when unpriced.
  - `tokens.costDays: z.array(z.object({ day: z.string(), values: z.array(z.number().nonnegative()) }))` — one row per bucket, `values` aligned with `tokens.models` (including `Other`); an unpriced model contributes 0.

- [ ] **Step 1: Write the failing tests** in `analytics.test.ts` (fixtures use real ids so they price):
  - In `aggregates the last 7 days`: rename the fixture models to `claude-sonnet-4-6` and `claude-opus-5-5`; add `tokens: <sum of every kind in range>`, `estimatedCostUsd: <the hand-computed sum>` and `unpricedModels: []` to the `kpis` expectation; expect `r.tokens.totals[0].costUsd` to equal `costOf('claude-sonnet-4-6', totals[0])` and `r.tokens.costDays.find((d) => d.day === '2026-10-30')?.values[0]` to be that day's sonnet cost.
  - `unpriced models` — a range with `unknown` and `claude-3-5-sonnet-20241022` tokens beside `claude-opus-5-5`: `unpricedModels` is `['claude-3-5-sonnet-20241022', 'unknown']`, their `costUsd` is null, `estimatedCostUsd` equals opus's cost alone, `kpis.tokens` still counts all three.
  - `Other's cost` — six priced models (extend `folds models after the fourth into Other`): the `Other` slot of each `costDays` row equals the sum of the fifth and sixth models' costs that day.
  - `an empty range has zeros everywhere…`: also `tokens: 0`, `estimatedCostUsd: 0`, `unpricedModels: []`, every `costDays` value 0.
- [ ] **Step 2: Run** the service analytics tests — expect FAIL.
- [ ] **Step 3: Implement.** In the per-day pass, price each `(day, model)` row with `costOf` once; accumulate the KPI cost, the per-model `costUsd` and the per-bucket `costDays` (same slot logic as `tokenDays`, `Other` at `MAX_MODELS`); collect unpriced models with any tokens into a `Set`. Add the protocol fields.
- [ ] **Step 4: Run** service and protocol tests, service and protocol typecheck — expect PASS.
- [ ] **Step 5: Commit** `feat(service): Analytics counts every token and estimates their cost`.

### Task 3: Tiles and the cost chart

**Files:**
- Modify: `apps/desktop/src/lib/components/analytics/format.ts` (add `usd`)
- Modify: `apps/desktop/src/lib/components/analytics/AnalyticsView.svelte` (KPI list ~line 82; a new `ChartCard` after `an-tokens` ~line 252)
- Modify: `apps/desktop/e2e/analytics.spec.ts` if it names the "Output tokens" tile
- Test: `apps/desktop/tests/analytics/format.test.ts`, `apps/desktop/tests/analytics/analytics.test.ts`

**Interfaces:**
- Consumes: the Task 2 fields.
- Produces: `export const usd = (n: number): string` in `format.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `format.test.ts`: `usd(0)` is `'$0'`; `usd(0.004)` is `'< $0.01'`; `usd(3.456)` is `'$3.46'`; `usd(42.4)` is `'$42'`; `usd(1432)` is `'$1.4K'`; `usd(2_500_000)` is `'$2.5M'`.
  - `analytics.test.ts` (with a fixture carrying the new fields):
    - the tiles read `Tokens` (compact total; title lists `Input`, `Output`, `Cache read`, `Cache write` with `full` numbers, summed from `tokens.totals`) and `Est. cost` (`≈ ` + `usd(estimatedCostUsd)`); there is no `Output tokens` tile;
    - the cost tile's title contains `Estimated at API list prices` and, when `unpricedModels` is non-empty, `Not priced: ` followed by the names joined with `, `;
    - `cost tile without prices` — tokens > 0, `estimatedCostUsd` 0, `unpricedModels` non-empty: the tile value is `—`;
    - a card titled `Estimated cost by model` exists; its table view has columns `Model`, `Input`, `Output`, `Cache read`, `Cache write`, `Est. cost` with `usd(costUsd)` or `—` for null, and a per-bucket table of `usd` values.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter desktop exec vitest run tests/analytics` — expect FAIL.
- [ ] **Step 3: Implement.** `usd`: `'$0'` for 0, `'< $0.01'` below 0.01, two decimals below 10, whole dollars below 1,000, then `Intl` compact with one fraction digit and a `$`. Tiles as tested (order: Chats, Messages, Tokens, Est. cost, Active days, Busiest project; check the tile row still fits at 720 px — `interface-size.spec.ts` covers it). The cost card: `id="an-cost"`, description `"Rough, at API list prices, per {week ? 'week' : 'day'}"`, `empty` when `estimatedCostUsd === 0`, `ColumnChart` with the same series names and colors as `tokenSeries` (reuse its slot logic; values from `tokens.costDays`) — if `ColumnChart` formats its axis with `compact`, give it a value-format prop defaulting to `compact` and pass `usd`.
- [ ] **Step 4: Run** desktop vitest for `tests/analytics`, desktop typecheck and lint — expect PASS; then the whole desktop suite.
- [ ] **Step 5: Commit** `feat(desktop): Analytics shows every token and a rough cost`.

### Task 4: Wrap-up

- [ ] Full service and desktop suites; `pnpm --config.verify-deps-before-run=false --filter desktop test:e2e analytics interface-size` if Chromium is installed.
- [ ] Add "a cost readout per chat, like the CLI's" to the vault's `Threadgarden/To decide.md`; commit and push the vault.
- [ ] Open the PR into `main`.
