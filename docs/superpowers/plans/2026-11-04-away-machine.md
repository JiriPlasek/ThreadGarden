# A machine that's away: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a paired machine can't be reached, this device shows its projects, chats and the last few messages of each, and anything typed for it (a reply or a new chat) waits safely on this device. The machine is turned on, and the message is delivered exactly once when it's up.

**Architecture:**
- **The machine's side (protocol 11):** `chat.send` takes a `messageId` it remembers, and `chat.create` takes a `sessionId` chosen by the client, both idempotent. A capability, `away`, says a machine does both.
- **The local service** keeps the copy (lists plus the last few messages per chat) and the queue in its own database. A deliverer of its own opens a link to the machine with the token it already holds, turns the machine on through the power hub, and sends.
- **The desktop** saves the copy while connected. While the machine isn't connected, its scope reads through a copy-backed API, so the existing lists and chat view keep working. Sends go to the queue.

**Tech Stack:** Node 22 service (SQLite, `openLink`), zod protocol, Svelte 5, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-away-machine-design.md`

## Global Constraints

- **Protocol:** `PROTOCOL_VERSION = 11`; `REMOTE_PROTOCOL_RANGE = { min: 10, max: 12 }`; the Rust copy in `apps/desktop/src-tauri/src/service.rs` goes to 11; capability `'away'` (`AWAY_CAPABILITY`). Keep the literal `PROTOCOL_VERSION = 11;`.
- **Part B's plan** adds only an optional `MachineInfo.host`, without a bump. Expect a small merge in `packages/protocol/src/machines.ts`.
- **"Away"** means this device isn't connected to the machine: `entry.status !== 'on'` (Off, Unreachable, Connecting, Starting). The copy is used then.
- **Turning on:** only when `machines.shown(m) === 'off'` (power control with a plug reading Off). Never turn on, or cycle, a machine in any other state.
- **The copy:**
  - per machine: its `MachineInfo`, projects, up to **500** most recent chat summaries, and per chat the last **10** messages of kinds `user`, `assistantText` and `permissionRequest` (others dropped);
  - "last seen" is when it was last refreshed;
  - all of it is Threadgarden's own data in the local service's database, never under `~/.claude`.
- **The queue:** rows on this device's local service, kinds `send` and `create`, delivered in creation order per machine. A row leaves the queue only when the machine accepted it, or the owner cancels it.
- **Exactly once:**
  - every queued row carries a `messageId` (a UUID chosen by the client) and, for `create`, a `sessionId` (a UUID chosen by the client);
  - the machine remembers received `messageId`s for 30 days;
  - a `chat.create` for an existing `sessionId` returns it unchanged.
- **The start window:** 5 minutes (the power hub's existing give-up). An attempt cut short by this device sleeping or its service stopping counts as not tried: if more than 90 s passed between two ticks, or the service started with rows pending, a new attempt starts. A full window spent awake ends in `failed` with reason `start`, which waits for Retry.
- **Copy:**
  - `‹machine› is off: showing its last few messages, from ‹time› ago.`
  - `… earlier messages are on ‹machine›`
  - `⏳ Waiting for ‹machine› — turning it on, sends when it's up. Keep this device awake.`
  - `⏳ Waiting for ‹machine› — sends when it's reachable.`
  - `Cancel`, `Retry`
  - `‹machine› didn't come up` (the start failure)
  - `last seen ‹time› ago`
  - `Available when ‹machine› is on`
  - `Starting ‹machine›…`
  - `Update ‹machine› to send while it's off`
- **Repo conventions:** `pnpm --config.verify-deps-before-run=false`; no Claude attribution; plain separate git commands.

## Review Focus

1. **The connection drops after the machine accepted a message but before this device heard back.** The retry carries the same `messageId`, and the message appears once. Test: Task 2 `a repeated messageId is accepted once`, plus Task 4 `a lost answer is retried with the same messageId`.
2. **The laptop sleeps for an hour during the start, then wakes.** It must start again rather than show a failure, and it must not power-cycle a PC that's already booting. Test: Task 4 `a start interrupted by sleep starts again on wake` and `a machine whose plug reads on is not turned on again`.
3. **The app restarts with rows waiting:** the local service has no token until the desktop unlocks it. Rows wait without errors and go out after unlock. Test: Task 4 `rows wait for the token and go out after unlock`.
4. **The chat was moved, or deleted on the machine, while a reply waited.** The row becomes `failed` with the machine's message, and is kept and shown, never dropped silently. Test: Task 4 `a refusal from the machine fails the row and keeps it`.
5. **An older machine without `away`:** nothing is queued for it, and the composer says to update it. Test: Task 6 `a machine without the away capability can't queue`.

---

### Task 1: Protocol 11

**Files:**
- Create: `packages/protocol/src/away.ts`, `packages/protocol/test/away.test.ts`.
- Modify: `packages/protocol/src/{methods,events,version,machines,index}.ts`, the version and range pins in `packages/protocol/test/*` and `apps/desktop/tests/state/machines.test.ts`, `apps/desktop/src-tauri/src/service.rs`, `packages/service/test/server/local-only.test.ts`.

**Interfaces:**
- Produces:
  - `AWAY_CAPABILITY = 'away'`.
  - `chat.send` params gain `messageId?: string` (uuid).
  - `chat.create` params gain `sessionId?: string` (uuid).
  - `CopyItemSchema`: the subset of `ChatItem` kinds `user`, `assistantText`, `permissionRequest`.
  - `MachineCopySchema = { machineId, info: MachineInfo | null, projects: Project[], chats: ChatSummary[], copiedAt: number }`.
  - `ChatCopySchema = { machineId, sessionId, summary: ChatSummary, items: CopyItem[], copiedAt }`.
  - `AwayItemSchema = { id, machineId, sessionId, kind: 'send' | 'create', text, imageCount, cwd: string | null, createdAt, state: 'waiting' | 'sending' | 'failed', reason: 'start' | 'refused' | null, error: string | null }`.
  - `AwayStateSchema = { machineId, starting: boolean, startedAt: number | null }`.
  - Local-only methods:
    - `copies.saveLists {machineId, info, projects, chats} → {}`;
    - `copies.saveChat {machineId, sessionId, summary, items} → {}`;
    - `copies.get {machineId} → MachineCopy | null`;
    - `copies.chat {machineId, sessionId} → ChatCopy | null`;
    - `copies.tails {machineId} → Record<sessionId, number>` (each copied chat's `lastActivity`);
    - `away.queue {machineId, sessionId, kind, text, images?, cwd?, model?, permissionMode?, effort?} → AwayItem`;
    - `away.list {machineId?} → { items: AwayItem[], states: AwayState[] }`;
    - `away.cancel {id} → {}`;
    - `away.retry {machineId} → {}`.
  - Event `away.changed { items, states }`.

- [ ] **Step 1: Failing tests:**
  - `PROTOCOL_VERSION is 11 and the remote range is 10..12`;
  - `chat.send and chat.create accept and still parse without the new ids`;
  - `away and copies methods and the away.changed event are listed`;
  - `CopyItemSchema refuses a toolCall`.
  - Update the pins. In `local-only.test.ts`, every `copies.*` and `away.*` method is forbidden to a paired device.
- [ ] **Step 2: Run** the protocol tests. FAIL.
- [ ] **Step 3: Implement.** `version.ts` gets the line `11 — a machine that's away: the away capability, messageId on chat.send, sessionId on chat.create; local copies.* and away.*`.
- [ ] **Step 4: Run** the protocol tests, `cargo test protocol_version`, and the desktop range test. PASS.
- [ ] **Step 5: Commit** `feat(protocol): protocol 11 for a machine that's away`.

### Task 2: The machine accepts ids (idempotent send and create)

**Files:** Modify `packages/service/src/history/migrations.ts` (a step: `received_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL)`), `packages/service/src/history/db.ts`, `packages/service/src/server/handlers/chat.ts`, `packages/service/src/chat/session-host.ts` or `live-session.ts` (pass `sessionId` through), `packages/service/src/main.ts` (capability `away` on every service), and tests under `packages/service/test/server/`.

**Interfaces:**
- `chat.send` with a `messageId` already received for that chat returns `{queued: false}` and does nothing.
- `chat.create` with a `sessionId` that already exists returns `{sessionId}` and does nothing; with a new one, the chat gets that id.
- Received ids older than 30 days are pruned at start.

- [ ] **Step 1: Failing tests:**
  - `a repeated messageId is accepted once`;
  - `a messageId is remembered across a service restart`;
  - `chat.create with a client sessionId uses it`;
  - `chat.create with an existing sessionId returns it and creates nothing`;
  - `the away capability is offered`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** Record the id in the same step that accepts the send, so a crash between them can't send twice.
- [ ] **Step 4: Run** the service suite. PASS.
- [ ] **Step 5: Commit** `feat(service): a machine accepts a message or a new chat once, by id`.

### Task 3: The local copy store

**Files:** Create `packages/service/src/away/copies.ts`, `packages/service/src/server/handlers/copies.ts` and tests. Modify `migrations.ts` (a step: `machine_copies (machine_id TEXT PRIMARY KEY, json TEXT NOT NULL, copied_at INTEGER NOT NULL)` and `chat_copies (machine_id TEXT, session_id TEXT, json TEXT NOT NULL, last_activity INTEGER, copied_at INTEGER NOT NULL, PRIMARY KEY (machine_id, session_id))`) and `main.ts` (register local-only).

**Interfaces:**
- Produces `class CopyStore { saveLists(...); saveChat(...); get(machineId); chat(machineId, sessionId); tails(machineId); forget(machineId) }`, plus the handlers.
- `saveLists` keeps at most 500 chats and removes chat copies no longer in the list.
- `saveChat` keeps the last 10 copy items of the allowed kinds.
- Removing a paired machine (`machines.remove`) calls `forget`.

- [ ] **Step 1: Failing tests:**
  - `saveLists keeps the 500 most recent and drops chat copies no longer listed`;
  - `saveChat keeps only the last 10 user, assistant and permission items`;
  - `tails reports each chat copy's lastActivity`;
  - `removing a machine forgets its copy`;
  - `copies methods are local-only`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `feat(service): a local copy of each paired machine's lists and last messages`.

### Task 4: The local queue and its deliverer

**Files:** Create `packages/service/src/away/queue.ts` (the store), `packages/service/src/away/deliverer.ts`, `packages/service/src/server/handlers/away.ts` and tests. Modify `migrations.ts` (a step: `away_queue (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, error TEXT)`) and `main.ts` (build the deliverer; the idle exit also waits while rows are waiting, next to `sendsPending()`).

**Interfaces:**
- Consumes: `PairedMachines` (`get`, `token`, the stored pin), `openLink` (`machine/link.ts`), `PowerHub` (`turnOn`, `reading`), Task 2's ids.
- Produces:
  - `class AwayDeliverer { tick(): Promise<void>; retry(machineId); cancel(id); onUnlock(machineId) }`, with injected `now`, `timers` and `connect(machineId) → Promise<Link | null>`.
- Per machine with waiting rows, each tick:
  1. Try to connect, if the token is known.
  2. If connected: send the rows in order (`create` → `chat.create {sessionId, cwd, text, …}`; `send` → `chat.send {sessionId, text, images?, messageId}`). Each accepted row is deleted and `away.changed` emitted. `DISCONNECTED` or `TIMEOUT` leaves the row `waiting`. Any other error sets it `failed`, reason `refused`, with the machine's message.
  3. If not connected and power is configured with a reading below `offWatts`, and no attempt is running: `turnOn` and record `startedAt`.
  4. If an attempt has run 5 minutes awake: the rows become `failed`, reason `start`.
- Ticks run every 5 s while rows wait.
- Sleep detection is per Global Constraints.
- No token: rows wait, with no error.

- [ ] **Step 1: Failing tests,** with a fake link, a fake hub and fake timers:
  - `queued rows go out in order once connected and leave the queue`;
  - `a lost answer is retried with the same messageId`;
  - `a refusal from the machine fails the row and keeps it`;
  - `an Off machine with power control is turned on once per attempt`;
  - `a machine whose plug reads on is not turned on again`;
  - `a start that runs 5 minutes awake fails with reason start and Retry starts again`;
  - `a start interrupted by sleep starts again on wake`;
  - `rows wait for the token and go out after unlock`;
  - `cancel removes a waiting row and not a sending one`;
  - `the local service doesn't idle-exit while rows wait`;
  - `away methods are local-only`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the service suite. PASS.
- [ ] **Step 5: Commit** `feat(service): messages for a machine that's away wait here and go out once`.

### Task 5: The desktop keeps the copy fresh

**Files:** Create `apps/desktop/src/lib/state/copy-sync.svelte.ts` and its test. Modify `state/app.ts` (wiring).

**Interfaces:**
- Consumes the scope's API while connected, and Task 3's `copies.*` on the local service.
- Produces `CopySync`. On each connect and on every `sessions.changed` or `projects.changed` (debounced about 2 s), it saves the lists:
  - `projects.list`;
  - the 500 most recent chats, via `sessions.list` over the all-chats place, paged;
  - `info`.
- It then refreshes the tails of chats whose `lastActivity` is newer than `copies.tails` says, with `chat.open {tail: 30}` filtered to copy kinds, last 10, two at a time.
- It never runs while the machine is away.

- [ ] **Step 1: Failing tests:**
  - `on connect the lists are saved and changed chats' tails refreshed`;
  - `an unchanged chat's tail isn't fetched again`;
  - `nothing is fetched while the machine is away`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `feat(desktop): keep a copy of each machine's chats while connected`.

### Task 6: The away machine in the lists and the chat view

**Files:**
- Create `apps/desktop/src/lib/state/copy-api.ts`, `apps/desktop/src/lib/state/away.svelte.ts` and tests.
- Modify `state/scope.ts` (the scope's API delegates to the copy API while away), `components/layout/PlacesColumn.svelte` (drop "Its chats appear once it's on." when a copy exists), `layout/MachineHeading.svelte` (`last seen …`), `ChatView.svelte` (the copy note, earlier-messages line, waiting lines, Cancel/Retry, composer rules), `state/merged-list.svelte.ts` (an away machine with a copy is not "missing"), and `state/places.svelte.ts` (copy counts).

**Interfaces:**
- `copyApi(machineId, local)` answers:
  - `places.counts`, `projects.list`, `sessions.list` and `chat.open`, from the copy;
  - `chat.older → {items: [], hasMore: false}`;
  - `chat.resumeCheck → ok`;
  - `chat.send → away.queue` (with a fresh `messageId`), `chat.create → away.queue`;
  - anything else throws `AWAY` with `‹machine› is off`.
- `AwayState` mirrors `away.list` and `away.changed`, with `items(ref)`, `starting(machineId)`, `cancel(id)` and `retry(machineId)`.
- Composer rules:
  - a machine whose remembered info lacks `away`: disabled, with `Update ‹machine› to send while it's off`;
  - otherwise enabled, with the waiting line chosen by whether it can be turned on.

- [ ] **Step 1: Failing tests:**
  - `an away machine's group lists its copied projects and chats with last seen`;
  - `opening its chat shows the copy note and the last messages without contacting it`;
  - `sending queues the message and shows the waiting line with Cancel`;
  - `a failed start shows the line and Retry`;
  - `when the machine connects the chat is live again and the waiting line goes`;
  - `a machine without the away capability can't queue`;
  - `a machine never seen shows Its chats appear once it's on`;
  - `a permission request in the copy is shown, and a typed answer is queued as the next message`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the desktop suite, typecheck and lint. PASS.
- [ ] **Step 5: Commit** `feat(desktop): read and reply to a machine that's away`.

### Task 7: New chat on a machine that's away

**Files:** Modify `components/NewChatDialog.svelte` (offer away machines with a copy: its existing folders and Home, with New project, Clone and Browse… disabled and `Available when ‹machine› is on`), `state/chats.svelte.ts` (create through the copy API with a client `sessionId`; open the tab at once) and `ChatView.svelte` (a chat known only from the queue shows `Starting ‹machine›…` and its first message). Tests.

**Interfaces:** Consumes Tasks 1, 4 and 6. The tab key is `{machineId, sessionId}` with the client-chosen id, so no swap is needed when the machine creates it.

- [ ] **Step 1: Failing tests:**
  - `New chat offers an away machine with its copied folders and Home`;
  - `New project, Clone and Browse are disabled while it's away`;
  - `sending opens the chat at once with Starting and the waiting first message`;
  - `once delivered, the same tab is the live chat`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `feat(desktop): start a new chat on a machine that's away`.

### Task 8: The mock and the e2e

**Files:** Modify `packages/service/src/testing/mock-main.ts` (mock-only hooks: `mock.goAway` drops device sockets and refuses new ones; `mock.comeBack`; the fake plug reads 0 W while away, and when it's switched on through Tasmota the remote comes back after about 2 s) and `apps/desktop/e2e/` (a new `away.spec.ts`).

- [ ] **Step 1: Write the spec:**
  - `an away machine shows its copied chats and the last messages`;
  - `a reply while away turns it on and is delivered once` (assert the remote got exactly one message);
  - `Cancel removes a waiting reply`;
  - `a new chat while away opens at once and starts when it's up`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false test:e2e`. Tasks 1–7 must make it pass.
- [ ] **Step 3: Commit** `test(e2e): a machine that's away`.

### Task 9: Docs

**Files:** `docs/remote-machines.md` (a "When it's off" section: the copy, waiting messages, Cancel and Retry, "keep this device awake", the VPN that reaches the home network for turning it on from outside), `docs/architecture.md` (protocol 11, the copy and the queue on the local service), and the README feature line.

- [ ] **Step 1:** Write them.
- [ ] **Step 2:** `prettier --check README.md`.
- [ ] **Step 3: Commit** `docs: a machine that's away`.

## After the build (owner)

1. Release, then update kumbal **from Settings**. That's also the first real update test.
2. With kumbal off: open one of its chats, reply, and watch it turn on and the reply go out.
3. Start a new chat on it while it's off.
4. Close the laptop lid during a start, open it again, and check the message still goes out.
