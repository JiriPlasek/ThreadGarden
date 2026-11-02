# Usage per account: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop shows every machine's plan usage grouped by Claude account. There is one bottom-bar chip per account, with the limit breakdown, and one Usage dialog section per account. Chats on any machine use their own machine's limits.

**Architecture:**
- **Service:** each service tags its `UsageState` with the signed-in account, from `accountInfo()`, and starts fresh when the account changes.
- **Desktop:** it gets a `UsageStore` per machine scope, like the other per-machine stores. A pure `groupUsage` turns the scopes' states into account entries for the bar and the dialog. Chat-level limit UI reads the chat's own scope.

**Tech Stack:** TypeScript, zod (`@threadgarden/protocol`), Node 22 service with `node:sqlite`, SvelteKit 5 runes, vitest and Testing Library, Rust (Tauri), but only for the protocol constant.

**Spec:** `docs/superpowers/specs/2026-11-02-usage-per-account-design.md`

## Global Constraints

**Environment**
- Agent environment: run pnpm as `pnpm --config.verify-deps-before-run=false …`, and never run a bare `pnpm install`.
- To run one test file, run `pnpm --config.verify-deps-before-run=false exec vitest run <path>` from the package directory.
- Rust: `PATH="/c/Users/drnek/.rustup/toolchains/1.99.1-x86_64-pc-windows-msvc/bin:$PATH" cargo.exe test`.
- Commits carry **no** Claude attribution lines.

**Protocol**
- `PROTOCOL_VERSION = 8` in `packages/protocol/src/version.ts` **and** in `apps/desktop/src-tauri/src/service.rs`, where a test checks they match.
- The remote range is `{ min: 7, max: 8 + 1 }`, that is `{ min: 7, max: 9 }`.

**Account identity**
- The account is `{ email?: string; plan?: string; kind: 'login' | 'apiKey' | 'provider'; provider?: string }`.
- Emails are compared trimmed and lower-cased.
- A missing account means unknown. An unknown account is never merged with another machine.

**Bar chips (spec §2)**
- Format: `This PC · 5h 42% · Week 18% · Fable 30%`.
- Labels:
  - 5-hour window: `5h`.
  - `seven_day`: `Week`.
  - Per-model windows: the model's label (`model:<label>` → `<label>`; `seven_day_opus` → `Opus`; `seven_day_sonnet` → `Sonnet`).
  - Other windows appear only in the dialog.
- The machine part lists the entry's machines by name, joined with `, `. It's left out when This PC is the only machine paired.
- **Hover** (`title`): the first line is the email (or `Account not known yet`). Then one line per window: `‹window label›: ‹n›%, resets ‹time›`, using the existing `windowLabel` and the formatter the meter uses today.
- **Off machine:** `· as of HH:MM` is appended, from the newest `observedAt` of that machine's windows.
- **Narrow bar:** each chip shows its 5-hour figure alone, and the bar never wraps.
- **No chip** for an entry of kind `apiKey`/`provider`, or for an entry without a 5-hour window (`five_hour` or `current`).

**Dialog (spec §2, §4)**
- One section per entry. Its heading is the email (or the machine name when the account is unknown) with ` · ‹plan›`, and the machines on the right.
- An `apiKey`/`provider` entry shows `‹machine› · API key` (or `· ‹provider›`) and the existing "limits don't apply" line.
- An entry without windows shows `No reading yet`.

**Per-chat limits (spec §5)**
- The refusal notice and **Send when the limit resets** read the **chat's own scope's** `UsageStore`, not the merged entry.

## Review Focus

1. **An account switch on a running machine.** The old windows are dropped; refusals already recorded stay. Test: Task 2.
2. **The same email in different case or with spaces on two machines.** One entry. Test: Task 3.
3. **A 0.5 remote (protocol 7, no `account`) next to This PC on a known account.** Two entries, never merged. Test: Task 3.
4. **An off machine whose stale rejected window has since reset.** Its chip shows no red. `windowStatus` already lapses statuses after the reset time; the chip must use it. Test: Task 4.
5. **A narrow window with two chips.** Only the 5-hour figures show, and nothing wraps. Test: Task 4 (the `compact` prop).

## Out of scope

- The analytics half of plan 3's "combined across machines".
- Switching accounts from Threadgarden.
- Usage extras (cost, auto-resume, snooze).

## File structure

**Protocol:** `packages/protocol/src/usage.ts` (`UsageAccountSchema`), `version.ts`, `machines.ts`.

**Service**
- `packages/service/src/usage/usage.ts`: `UsageTracker.noteAccount`, and the account in `state()`, persisted.
- `packages/service/src/chat/live-session.ts`: the `onAccount` dep.
- `packages/service/src/chat/session-host.ts`: passes `onAccount` through.
- `packages/service/src/main.ts`: wiring.

**Desktop**
- `apps/desktop/src/lib/state/usage.svelte.ts`: the per-scope store gains `connected`, plus a last-known copy for remote scopes.
- `apps/desktop/src/lib/usage/accounts.ts` (new): pure `groupUsage`, `chipWindows`.
- `apps/desktop/src/lib/state/usage-accounts.svelte.ts` (new): `UsageAccounts`, which holds the entries, the dialog state and refresh across scopes.
- `apps/desktop/src/lib/state/scope.ts`: `usage` in `MachineScope`.
- `apps/desktop/src/lib/components/layout/UsageMeter.svelte`: the chips.
- `apps/desktop/src/lib/components/UsageDialog.svelte`: the sections.
- `apps/desktop/src/lib/components/chat/ChatView.svelte`, `ScheduledSends.svelte`, `QuickSwitcher.svelte`.

**Docs:** `docs/architecture.md`, the usage section.

---

### Task 1: Protocol 8 with the account on the usage state

**Files:** Modify `packages/protocol/src/usage.ts`, `version.ts`, `machines.ts`, `apps/desktop/src-tauri/src/service.rs:18`. Test: `packages/protocol/test/usage.test.ts`, plus any version/range assertions in service and desktop tests.

**Interfaces (Produces):**
```ts
export const UsageAccountSchema = z.object({
  email: z.string().optional(), plan: z.string().optional(),
  kind: z.enum(['login', 'apiKey', 'provider']).catch('login'), provider: z.string().optional(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;
// UsageStateSchema gains: account: UsageAccountSchema.optional()
```

- [ ] **Step 1: Write the failing tests.**
  - A state with an `account` parses.
  - A state without one parses, with `account` undefined.
  - An unknown `kind` reads as `login`.
  - `PROTOCOL_VERSION` is `8`, and `REMOTE_PROTOCOL_RANGE` is `{ min: 7, max: 9 }`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - Add the doc line `8 — usage per account: the signed-in account on the usage state.`
  - Update the Rust constant to 8.
  - Update stale version assertions in service and desktop tests to the new truth (as Task 3 of the previous plan did).
- [ ] **Step 4: Run** the protocol tests, the service and desktop suites, and the Rust `cargo test --lib service::`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(protocol): protocol 8 with the account on the usage state`.

### Task 2: The service knows its account and starts fresh when it changes

**Files:** Modify `packages/service/src/usage/usage.ts`, `chat/live-session.ts` (~line 820), `chat/session-host.ts` (~lines 66, 314, 331), `main.ts` (~line 568). Test: `packages/service/test/usage/` (the existing usage tracker tests' folder; find it with `grep -rl UsageTracker packages/service/test`).

**Interfaces:**
- **Consumes:** Task 1's `UsageAccount`.
- **Produces:**
```ts
export const accountOf = (info: AccountInfo): UsageAccount;   // usage.ts; same precedence as live-session's authLabel: API key first, then a claude.ai login (email, subscriptionType), then a non-firstParty apiProvider → kind 'provider', provider = apiProvider
UsageTracker.noteAccount(account: UsageAccount): void;
// LiveSessionDeps gains onAccount?: (info: AccountInfo) => void, called with every accountInfo() answer
```

**Rules for `noteAccount`:**
- **The same account** (normalised email, kind and provider equal): only update `plan` if it changed.
- **A different email than the known one,** both known: drop all windows (persisted rows too) and keep `refused`.
- **Always:** set the account, persist it in the `@account` row next to `subscriptionType`/`rateLimitsAvailable`, and publish once.
- **First account learned** (the previous state had none, as after an upgrade from 0.5): keep the windows. They were this machine's own readings, so attribution stays per machine.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `accountOf`: a claude.ai login with email; an API key wins over a stored login; bedrock → `provider`.
  - `the first account keeps the windows and is reported in state()`.
  - `a different email drops the windows but keeps refusals` (Review Focus 1).
  - `the same email in another case keeps everything`.
  - `the account survives a restart` (a new tracker on the same db).
  - LiveSession: `onAccount is called with the accountInfo answer`, using the existing live-session test fakes.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement and wire.** `main.ts` passes `onAccount: (info) => usageTracker.noteAccount(accountOf(info))` to the SessionHost.
- [ ] **Step 4: Run** the usage tests, then the service suite once, plus typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(service): usage knows its account and starts fresh when it changes`.

### Task 3: A usage store per machine and the account entries

**Files:**
- Modify `apps/desktop/src/lib/state/usage.svelte.ts` and `apps/desktop/src/lib/state/scope.ts` (`usage` in `MachineScope`/`ScopeStores`; This PC's scope uses the singleton `usage`; `createScope` makes `new UsageStore({ remember: machineId })`; `wireScope` inits it for remote scopes, and This PC's stays initialised in `app.ts`).
- Create `apps/desktop/src/lib/usage/accounts.ts` and `apps/desktop/src/lib/state/usage-accounts.svelte.ts`.
- Test: `apps/desktop/tests/usage/accounts.test.ts` (new), `apps/desktop/tests/usage/usage.test.ts`.

**Interfaces (Produces):**
```ts
// usage.svelte.ts
class UsageStore {
  constructor(opts?: { remember?: string });   // remote scopes: last state kept in localStorage `threadgarden.usage.<machineId>` and restored at construction
  value: UsageState; connected: boolean;       // connected = its api is open
  limitResetAt: number | undefined; refusal(sessionId): RefusedChat | undefined; refresh(): Promise<void>;
}
// accounts.ts
export type UsageMachine = { machineId: string; name: string; state: UsageState; connected: boolean };
export type UsageEntry = {
  key: string;                                  // 'email:<lowercase email>' | 'machine:<id>' (unknown / apiKey / provider)
  account: UsageAccount | undefined; machines: UsageMachine[];
  windows: UsageWindow[];                       // per key, the newest observedAt among the machines
  asOf: number | undefined;                     // set when every machine of the entry is disconnected: newest observedAt
};
export const groupUsage = (machines: UsageMachine[]): UsageEntry[];   // input order = This PC first, then the places column order; entries keep the order of their first machine
export const chipWindows = (e: UsageEntry): UsageWindow[];            // 5h (five_hour|current), seven_day, then per-model weekly windows (model:*, seven_day_opus, seven_day_sonnet), in that order
// usage-accounts.svelte.ts
export class UsageAccounts {
  constructor(scopes: Pick<Scopes, 'all'>, names: (machineId: string) => string);
  entries: UsageEntry[]; dialogOpen: boolean; refreshing: boolean;
  open(): void; refresh(): Promise<void>;       // refresh asks every connected scope
}
export const usageAccounts: UsageAccounts;      // the app's instance (machine names from machines.svelte.ts / machineLabel)
```
`dialogOpen` and `refreshing` move from the singleton `UsageStore` to `UsageAccounts`. Callers of `usage.open()` are updated in Task 6.

**Steps**
- [ ] **Step 1: Write the failing tests** in `accounts.test.ts` for `groupUsage`:
  - `one account everywhere is one entry with both machines and the newest window per key`.
  - `two emails are two entries`.
  - `email case and spaces don't split an account` (Review Focus 2).
  - `a machine without an account is its own entry, even next to a known one` (Review Focus 3).
  - `an API-key machine is its own entry`.
  - `asOf is set only when all of an entry's machines are disconnected`.
  - `chipWindows orders 5h, Week, then model windows`.

  And for `UsageStore({ remember })`: `a remote store restores its last state from localStorage and keeps it after disconnect`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the usage tests and the desktop suite once, plus typecheck and lint. Expected: PASS. Existing usage tests may need their `open`/`dialogOpen` references moved; keep their assertions.
- [ ] **Step 5: Commit.** `feat(desktop): usage per machine, grouped by account`.

### Task 4: One chip per account in the bottom bar

**Files:** Modify `apps/desktop/src/lib/components/layout/UsageMeter.svelte` (and its parent only if needed to pass `compact`). Test: `apps/desktop/tests/usage/meter.test.ts` (new, or extend the existing meter test, whichever exists).

**Interfaces:**
- **Consumes:** Task 3's `usageAccounts.entries`, `chipWindows`, `windowStatus`, `windowLabel`.
- **Produces:** `UsageMeter` props `{ compact?: boolean }`. The component decides `compact` itself from its own measured width when not given. *(Builder's call: ResizeObserver on the bar slot, or a CSS container query. The test drives the prop.)*

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `one account: one chip, no machine names when only This PC exists, "5h 42% · Week 18% · Fable 30%"`.
  - `two accounts: two chips with their machine names; clicking either opens the dialog`.
  - `the hover lists the email, then one line per window with its reset`.
  - `an off machine's chip says "as of HH:MM"`.
  - `a stale rejected window past its reset is not red` (Review Focus 4).
  - `compact shows only the 5h figure` (Review Focus 5).
  - `no chip for an API-key entry or an entry without a 5-hour window`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Each figure gets the warning colour the meter uses today, from that window's status and utilisation.
- [ ] **Step 4: Run** the file and the desktop suite once, plus typecheck and lint. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): a usage chip per account with the limit breakdown`.

### Task 5: The Usage dialog per account

**Files:** Modify `apps/desktop/src/lib/components/UsageDialog.svelte`. Test: its existing test file (find it with `grep -rl UsageDialog apps/desktop/tests`).

- [ ] **Step 1: Write the failing tests.**
  - `two accounts: two sections headed by email · plan with their machines, each with its own windows`.
  - `an unknown account's section is headed by the machine name`.
  - `an API-key machine shows "‹machine› · API key" and the limits-don't-apply line`.
  - `an account without windows shows "No reading yet"`.
  - `one account looks as today` (the existing assertions keep passing).
  - `Refresh asks every connected machine`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** Reuse the dialog's existing per-window rows inside each section.
- [ ] **Step 4: Run** the file and the desktop suite once. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): the Usage dialog shows each account`.

### Task 6: Chats use their own machine's limits, and the docs

**Files:**
- Modify `apps/desktop/src/lib/components/chat/ChatView.svelte:185-187` (refusal and `resetAt` from `scope.usage`; remove the "This PC's only" comment), `ScheduledSends.svelte:139` (`resetAt` from the chat's scope), `QuickSwitcher.svelte:77` and `ChatView.svelte:540` (`usageAccounts.open()`).
- Modify `docs/architecture.md`, the usage section: per-machine stores, grouping by account, protocol 8.
- Test: `apps/desktop/tests/chat/remote-chat.test.ts`, plus the existing usage-limit chat tests (`grep -rl "limit resets" apps/desktop/tests`).

- [ ] **Step 1: Write the failing tests.**
  - `a chat on another machine shows "Usage limit reached" from that machine's refusal`.
  - `Send when the limit resets in a remote chat uses that machine's reset time, not This PC's`.
  - `a remote machine with no reset time hides the choice even when This PC has one`.
  - `This PC's chat is unchanged`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, and update the docs.
- [ ] **Step 4: Run the whole desktop suite,** then typecheck and lint for all packages from the repo root. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): chats use their own machine's usage limits`.

## After the build

Release (0.6.0), update the Ubuntu PC by hand, then check with the owner:
1. Two chips appear, This PC's and kumbal-machine's, each with its breakdown and the right email in the hover.
2. The Usage dialog shows two sections.
3. Narrow the window: the chips shrink to 5h.
4. Turn kumbal-machine off: its chip shows "as of …".
