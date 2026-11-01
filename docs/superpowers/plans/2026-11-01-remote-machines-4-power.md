# Remote machines, plan 4 of 4: Power — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paired machine is switched on and off through a Tasmota power switch from Threadgarden: a ⏻ menu, Off / Starting… / On / Shutting down states, a guided setup in Settings, idle shutdown with a push check, a power cut the switch makes only once the PC is down, and a wake for scheduled sends.

**Architecture:**
- **One power-switch interface in the service.** `packages/service/src/power/` holds a `PowerSwitch` interface and its Tasmota implementation, which talks HTTP to the switch with Node's `fetch`. There are two shapes: a Zigbee bridge driving a plug, and a Wi-Fi plug.
- **On the switch:** Threadgarden installs one rule, written into a single free rule slot, that polls the plug and cuts power, and a timer for wakes.
- **The desktop's local service (client side):** keeps each paired machine's switch configuration. It probes, configures, reads and turns on. The password comes from the OS keychain at unlock, like device tokens.
- **The machine's own service (headless):** keeps a copy of the configuration and owns idle detection, the push check and the shutdown sequence. It arms the cut on the switch, then runs `systemctl poweroff`.
- **The UI:** derives a machine's state from its link status plus the plug's reading.

**Tech Stack:**
- TypeScript: Node 22 `fetch`, `node:child_process` for git and poweroff, `node:sqlite`, zod.
- Tauri 2 / Rust (`keyring`), SvelteKit 5, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-remote-machines-design.md`:
- §10, revised 2026-11-01;
- the power parts of §7 (states, ⏻ menu, Settings);
- §12 step 1;
- the facts in §4.

**Builds on:** plan 1 (`2026-10-31-remote-machines-1-connect.md`), which is merged. Plan 2 is not built: there is no projects folder yet.

## Global Constraints

- **No cloud.** The switch is reached only on the LAN, over Tasmota's HTTP API `/cm?cmnd=…`, with user `admin` and the owner's web password (spec §10).
- **The webview never talks to the switch.** All switch traffic goes from a service. The CSP stays `connect-src ipc: http://ipc.localhost ws://127.0.0.1:*`.
- **Every switch request sends `Referer: http://<address>/`**, so `SetOption128` is never needed.
- **The password never appears** in logs, errors, events, results or the UI after entry.
  - On a client: stored in the OS credential store, account `power:<machine-id>`.
  - On a headless machine: stored in `<dataDir>/power-switch.json`, mode `0600`.
- **Threadgarden owns, on a switch:**
  - one rule slot (1–3);
  - RuleTimer 6, 7 and 8;
  - Var14 and Var15;
  - Mem11–Mem14;
  - Timer16.

  It never changes any other rule, timer, Var, Mem, device, Wi-Fi or firmware setting. It opens Zigbee pairing only during setup, at the owner's request, and never removes a device.
- **Defaults:**
  - "off" line **5 W**;
  - minimum off time **90 s** (range 10–600);
  - Shut down after idle **60 min** (or never);
  - cut after **6 readings 5 s apart below the line** (30 s);
  - arm expiry **900 s**;
  - wake **5 min** before a scheduled send;
  - Starting… gives up after **5 min**.
- **Copy:**
  - states: **Off · Starting… · On · Shutting down · Unreachable**;
  - ⏻ menu: **Turn on · Shut down now · Keep awake**;
  - unpushed notice: **"Unpushed work on ‹machine›"**, with **Ask Claude to push it** and **Shut down anyway**;
  - an Off machine's group: **"Its chats appear once it's on."**;
  - the Wi-Fi plug carries an **Experimental** label.
- **Protocol:**
  - `PROTOCOL_VERSION` becomes **6**, in all three places: `packages/protocol/src/version.ts`, `apps/desktop/src-tauri/src/service.rs`, and `packages/protocol/test/schemas.test.ts`.
  - `REMOTE_PROTOCOL_RANGE` becomes `{min: 5, max: 7}`: a desktop at 6 accepts machines at 5, 6 and 7, one version either way (spec §6).
  - Power methods are offered only for machines whose `hello` advertises the capability `power`.
- **Unchanged rules:**
  - The hard rule from CONTRIBUTING.md holds: nothing is ever written under the Claude config dir. `test/e2e/read-only.test.ts` keeps passing.
  - Threadgarden never offers `bypassPermissions`.
- **Process:** conventional commits; CI passes on Windows, macOS and Linux.

## Out of scope (later)

- **Plan 3:** an Off machine's projects and chat lists, readable chat copies, and answering or sending into an Off machine's chat so that it wakes. Until then, an Off machine's group shows only its heading, its ⏻ menu and the placeholder line, and nothing can be typed for it.
- **Plan 2:** the "Local only" chip on projects without a remote, since only plan 2's New project creates such repos. Until then, the push check skips those repos silently.
- **Later:** Shelly, Home Assistant and Wake-on-LAN switches (they are on the Notion list).

## Review Focus

1. **The owner presses the power button, or the PC is woken some other way, while a cut is armed.**
   - The cut must never fire on a running PC.
   - A reading at or above the line resets the count, the arm expires after 900 s, and the service disarms at every start.
   - Tests: Task 3 (rule text), Task 10 (disarm on start).
2. **The switch is unreachable or refuses the password at shutdown.**
   - The machine must **not** power off: it could never be turned on remotely again.
   - It stays On and its power status says why.
   - Test: Task 10.
3. **The bridge is shared with other automation** (the grow light uses Timer1, Timer2, Rule2, RuleTimer3 and Event `growlight`).
   - Installing, reinstalling and removing never touch them.
   - A conflict over Threadgarden's resources stops the setup with an explanation.
   - Tests: Task 3 and Task 4, against a fake holding the grow light's exact rule.
4. **Time zones and clock skew for the wake timer.** Tasmota timers run on the device's local time.
   - A send due at 03:00 local must arm Timer16 for 02:55 on that weekday, however the desktop's and the machine's zones differ.
   - Test: Task 4, with a device reporting UTC+1 and UTC+2.
5. **The link drops during a shutdown, or the desktop wakes from sleep mid-shutdown.**
   - The machine shows Shutting down, then Off.
   - High watts after the link is lost must not read as Starting…
   - Test: Task 12.

---

## File structure

**Protocol** (`packages/protocol/src/`)
- `power.ts` *(new)*: power schemas, error codes, `POWER_CAPABILITY`.
- `methods.ts`, `events.ts`: power methods and the `power.changed` event.
- `chat.ts`: setting `idleShutdownMinutes`.
- `machines.ts`: `REMOTE_PROTOCOL_RANGE`.
- `version.ts`: `PROTOCOL_VERSION` 6.

**Service** (`packages/service/src/`)
- `power/tasmota.ts` *(new)*: `TasmotaClient`, `PowerError`.
- `power/rules.ts` *(new)*: rule text and resource claiming (pure).
- `power/switch.ts` *(new)*: `PowerSwitch`, `createSwitch()`.
- `power/probe.ts` *(new)*: `probeSwitch()`, `pairPlug()`.
- `power/hub.ts` *(new)*: the client side, with configurations, readings and `turnOn`.
- `power/store.ts` *(new)*: the machine side, `power-switch.json`.
- `power/push-check.ts` *(new)*: `checkUnpushed()`.
- `power/idle.ts` *(new)*: `IdleMonitor`.
- `power/shutdown.ts` *(new)*: `ShutdownSequence`.
- `server/handlers/power.ts` *(new)*: every `power.*` handler.
- `history/migrations.ts`: the `machine_power` table.
- `testing/fake-tasmota.ts` *(new)*: an HTTP fake for tests, mock and e2e.
- `testing/mock-main.ts`: the `--fake-tasmota` flag.
- `main.ts`: wiring and capabilities.

**Packaging:** `packaging/headless/install.sh`, which installs the polkit rule.

**Desktop shell:** `apps/desktop/src-tauri/src/secrets.rs` and `lib.rs`, for the `power_password_*` commands; `service.rs` for the protocol version.

**Desktop UI** (`apps/desktop/src/lib/`)
- `native.ts`: `powerPasswords`.
- `state/power.svelte.ts` *(new)*: `PowerState`, readings and state derivation.
- `state/machines.svelte.ts`: new statuses, adopt sync, password unlock.
- `components/layout/MachineHeading.svelte`: ⏻ menu, states, countdown.
- `components/layout/PlacesColumn.svelte`: the Off placeholder, the unpushed notice in Needs you.
- `components/PowerSettings.svelte` *(new)*, `components/PowerSetupDialog.svelte` *(new)*, `components/MachinesSettings.svelte`.
- `components/UnpushedNotice.svelte` *(new)*.
- `notifications.ts`.

**Docs:** `docs/remote-machines.md`, `docs/architecture.md`, `README.md`, `CONTRIBUTING.md` (the local-only list).

**Tests:** next to the existing ones. The e2e spec is `apps/desktop/e2e/power.spec.ts` *(new)*.

---

### Task 1: Protocol — power schemas, methods, version 6

**Files:**
- Create: `packages/protocol/src/power.ts`
- Modify:
  - `packages/protocol/src/methods.ts`, `events.ts`, `chat.ts` (`SettingsSchema`, `settingsFields`, `SettingsPatchSchema`), `machines.ts`, `version.ts`, `index.ts`
  - `apps/desktop/src-tauri/src/service.rs:18`
- Test: `packages/protocol/test/power.test.ts`, `packages/protocol/test/schemas.test.ts:54`

**Interfaces:**
- **Produces (`power.ts`):**
  - **Kinds and config:**
    - `POWER_CAPABILITY = 'power'`
    - `PowerKindSchema = z.enum(['tasmota-zigbee', 'tasmota-plug'])`
    - `PowerConfigSchema = z.object({ kind, address: z.string().min(1), device: z.string().nullable(), offWatts: z.number().min(0.5).max(100).default(5), minOffSeconds: z.number().int().min(10).max(600).default(90), measured: z.object({ running: z.number().nullable(), standby: z.number().nullable() }).default({ running: null, standby: null }) })`. `device` is the Zigbee name, or `null` for a Wi-Fi plug.
  - **Readings and probing:**
    - `PlugReadingSchema = z.object({ on: z.boolean().nullable(), watts: z.number().nullable(), at: z.number() })`
    - `SwitchDeviceSchema = z.object({ id: z.string(), name: z.string().nullable(), on: z.boolean().nullable(), watts: z.number().nullable(), metering: z.boolean() })`
    - `ProbeResultSchema = z.object({ version: z.string(), kind: PowerKindSchema, devices: z.array(SwitchDeviceSchema), plug: PlugReadingSchema.nullable() })`
  - **Machine-side status:**
    - `UnpushedSchema = z.object({ repo: z.string(), branch: z.string().nullable(), kind: z.enum(['uncommitted', 'unpushed']), count: z.number().int(), sessionId: z.string().nullable() })`
    - `KeepAwakeSchema = z.object({ mode: z.enum(['off', 'always', 'until']), until: z.number().nullable() })`
    - `MachinePowerStatusSchema = z.object({ configured: z.boolean(), busy: z.boolean(), idleSince: z.number().nullable(), shutsDownAt: z.number().nullable(), keepAwake: KeepAwakeSchema, phase: z.enum(['running', 'checking', 'blocked', 'shuttingDown']), unpushed: z.array(UnpushedSchema), problem: z.string().nullable() })`
  - **`POWER_ERRORS`:** `{ unreachable: 'POWER_UNREACHABLE', auth: 'POWER_AUTH', notTasmota: 'POWER_NOT_TASMOTA', tooOld: 'POWER_TOO_OLD', refused: 'POWER_REFUSED', noMetering: 'POWER_NO_METERING', conflict: 'POWER_CONFLICT', notConfigured: 'POWER_NOT_CONFIGURED' }`
  - **`MIN_TASMOTA = '14.0.0'`** (Ruling: only 16.0.0 has been tried; 14 is the oldest the docs promise these commands for).
- **Produces (methods; `localOnly` marks the handlers that are client-side only):**
  - **Client side, `localOnly`:**
    - `power.probe {address, password} → ProbeResult`
    - `power.pairPlug {address, password} → SwitchDevice | null`, which waits at most 60 s
    - `power.configure {machineId, config: PowerConfig | null, password?: string} → PowerConfig | null`
    - `power.unlock {machineId, password} → {}`
    - `power.list {} → {machineId, config}[]`
    - `power.reading {machineId} → PlugReading`
    - `power.turnOn {machineId} → {cycled: boolean, waitMs: number}`
    - `power.rename {address, password, id, name} → {}`
    - `power.noteMeasurement {machineId, kind: 'running' | 'standby', watts} → {}`
  - **Machine side, open to paired devices:**
    - `power.adopt {config: PowerConfig | null, password?: string} → {}`
    - `power.status {} → MachinePowerStatus`
    - `power.keepAwake KeepAwake → MachinePowerStatus`
    - `power.shutdown {force: boolean} → MachinePowerStatus`
  - **Event:** `power.changed: MachinePowerStatus`.
  - **Setting:** `idleShutdownMinutes: z.number().int().min(5).max(1440).nullable()`, default `60`. `null` means never.

- [ ] **Step 1: Write the failing tests.**
  - `power.test.ts`:
    - `PowerConfigSchema.parse({kind:'tasmota-zigbee', address:'192.168.1.106', device:'UbuntuPlug'})` yields `offWatts 5`, `minOffSeconds 90` and `measured {running:null, standby:null}`.
    - `minOffSeconds: 5` is rejected.
    - `methods['power.shutdown']` exists.
    - `events['power.changed']` exists.
    - `SettingsSchema.shape.idleShutdownMinutes.parse(null)` returns `null`.
  - `schemas.test.ts:54`: expect `PROTOCOL_VERSION` to be `6`.
  - `machines.test.ts`, or wherever `acceptsRemoteProtocol` is tested: `5`, `6` and `7` are accepted; `4` and `8` are not.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/protocol test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the schemas and method entries above.**
  - Set `PROTOCOL_VERSION = 6`, and add a doc line to `version.ts`: "6 = power".
  - Set `REMOTE_PROTOCOL_RANGE = {min: 5, max: 7}`.
  - Set `service.rs` `PROTOCOL_VERSION: u32 = 6`.
- [ ] **Step 4:** run `pnpm --filter @threadgarden/protocol test` and `pnpm typecheck`. Expected: PASS. Also run the Rust test that compares versions: `cargo test` in `apps/desktop/src-tauri` after `pnpm --filter desktop build`.
- [ ] **Step 5: Commit** with `feat(protocol): power methods and protocol 6`.

### Task 2: Tasmota client and fake Tasmota

**Files:**
- Create: `packages/service/src/power/tasmota.ts`, `packages/service/src/testing/fake-tasmota.ts`
- Test: `packages/service/test/power/tasmota.test.ts`

**Interfaces:**
- **Produces:**
  - `class PowerError extends ServiceError`, with codes from `POWER_ERRORS`.
  - `class TasmotaClient { constructor(o: { address: string; password: string; fetch?: typeof fetch; timeoutMs?: number /* 5000 */ }); command(cmnd: string): Promise<Record<string, unknown>>; backlog(cmnds: string[]): Promise<void> }`
  - `startFakeTasmota(o?: { password?: string; requireReferer?: boolean; kind?: 'zigbee' | 'plug'; version?: string }) → Promise<FakeTasmota>`, where:
    - `FakeTasmota = { address: string; close(): Promise<void>; commands: string[]; rules: Record<1|2|3, {text: string; on: boolean}>; timers: Record<number, object>; mems: Record<number, string>; vars: Record<number, string>; devices: Map<string, {name: string | null; on: boolean; watts: number}>; utcOffsetMinutes: number; joinNext(dev): void }`
    - `address` is `127.0.0.1:<port>`.
- **Command semantics the fake implements** (case-insensitive; responses shaped like the real ones recorded in spec §4):
  - `Status 2`, which returns `{StatusFWR: {Version}}`.
  - `Status 7`, which returns `{StatusTIM: {UTC, Local}}` with the configured offset.
  - `Status 8`, for the plug kind only: `{StatusSNS: {ENERGY: {Power}}}`.
  - `Power`, `Power 0|1`, for the plug kind only.
  - `ZbStatus1`, `ZbStatus3 <name|id>`, `ZbSend {...Read|Send...}`, `ZbName <id>,<name>`, `ZbPermitJoin 1|0`. On the plug kind these answer `{"Command":"Unknown"}`.
  - `Rule<n>`, `Rule<n> <text>`, `Rule<n> 0|1`, `Timer16`, `Timer16 <json>`, `Mem<n>`, `Mem<n> <v>`, `Var<n>`, `SetOption83`, `SetOption83 1`, `Event <x>`.
  - `Backlog a;b;…`, split on `;` and run in order.
- **Error mapping in `command`:**
  - An HTTP 401, or a body `{"WARNING":"Need user=…"}`, becomes `POWER_AUTH`.
  - A connection refused or a timeout becomes `POWER_UNREACHABLE`.
  - An empty reply, or a socket closed with no body, becomes `POWER_REFUSED`.
  - A body that is not JSON becomes `POWER_NOT_TASMOTA`.
  - The password is URL-encoded into `user=admin&password=…` and never placed in an error message.

- [ ] **Step 1: Write the failing tests.**
  - `sends Referer and credentials`: the fake has `requireReferer: true`; `command('Status 2')` resolves with `{StatusFWR: {Version: '16.0.0(release-zbbrdgpro)'}}`.
  - `wrong password → POWER_AUTH, message without the password`: the client uses `'hunter2'` and the fake expects `'x'`. The error has code `POWER_AUTH`, and `String(err)` does not contain `hunter2`.
  - `closed port → POWER_UNREACHABLE` within `timeoutMs`.
  - `backlog joins with ';'`: `backlog(['Var14 0', 'Var15 1'])` leaves `fake.vars[14]` at `'0'` and `fake.vars[15]` at `'1'`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/tasmota.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both files.** Use `AbortSignal.timeout(timeoutMs)`. In the fake, `Backlog` splits on `;` outside braces.
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): Tasmota HTTP client and a fake Tasmota for tests`.

### Task 3: The rule and resource claiming (pure)

**Files:**
- Create: `packages/service/src/power/rules.ts`
- Test: `packages/service/test/power/rules.test.ts`

**Interfaces:**
- **Produces:**
  - `RESOURCES = { ruleTimers: [6, 7, 8], vars: [14, 15], mems: [11, 12, 13, 14], timer: 16 }`
  - `commandsFor(config: PowerConfig): { off: string; on: string; read: string; trigger: string }`
    - **Zigbee** (`D` = `config.device`):
      - `off`: `ZbSend {"Device":"D","Send":{"Power":0}}`
      - `on`: `ZbSend {"Device":"D","Send":{"Power":1}}`
      - `read`: `ZbSend {"Device":"D","Read":{"ActivePower":true}}`
      - `trigger`: `ZbReceived#D#ActivePower`
    - **Plug:**
      - `off`: `Power 0`
      - `on`: `Power 1`
      - `read`: `Status 8`
      - `trigger`: `StatusSNS#ENERGY#Power`
  - `ruleText(config: PowerConfig): string`: exactly the text below, with `T` = trigger, `W` = `offWatts` and `M` = `minOffSeconds`, joined by single spaces:
    ```
    on Event#tga do Backlog Var14 0;Var15 1;RuleTimer7 5;RuleTimer8 900 endon
    on Event#tgo do Backlog Var15 0;Var14 0;RuleTimer7 0;RuleTimer8 0 endon
    on Rules#Timer=7 do Backlog %mem14%;RuleTimer7 5 endon
    on T<W do Add14 %var15% endon
    on T>=W do Var14 0 endon
    on Var14#State>=6 do Backlog %mem12%;Mem11 %utctime%;Event tgo endon
    on Rules#Timer=8 do Event tgo endon
    on Event#tgw do Backlog %mem12%;RuleTimer6 M endon
    on Rules#Timer=6 do %mem13% endon
    on Clock#Timer=16 do Event tgw endon
    ```
    - Why this shape: `Add14 %var15%` counts low readings only while armed (Var15 = 1). The count is reset by any reading at or above the line, and by disarming.
    - Readings are polled (Mem14), because the S60 does not report drops (spec §4).
    - The text is longer than 511 characters, so Tasmota stores it compressed (verified in its source). Task 17 checks it on the real bridge.
  - `memsFor(config): Record<11|12|13|14, string>`: `{11: '0', 12: off, 13: on, 14: read}`.
  - `isOurs(text: string): boolean`: true when the text contains `Event#tga do`.
  - `chooseSlot(rules: Record<1|2|3, string>): 1 | 2 | 3 | null`: the slot that is ours, else the lowest empty one, else `null`.
  - `conflicts(rules: Record<1|2|3, string>, slot: 1|2|3, timers: Record<number, {Enable: number}>, mems: Record<number, string>, ourMems: Record<number, string>): string[]`. It returns human-readable problems:
    - another slot names any of `RuleTimer6|7|8`, `Rules#Timer=6|7|8`, `Var14`, `Var15`, `Mem11`–`Mem14` or `Clock#Timer=16`;
    - `Timer16` is enabled while our slot is empty, meaning it belongs to someone else;
    - a `Mem11`–`Mem14` value is neither empty nor what `memsFor` would write.

    Matches are whole words: `RuleTimer6` must not match `RuleTimer60`.

- [ ] **Step 1: Write the failing tests.**
  - `ruleText for the owner's plug`: for `{kind:'tasmota-zigbee', device:'UbuntuPlug', offWatts:5, minOffSeconds:90}` the output equals the block above with `T=ZbReceived#UbuntuPlug#ActivePower`, `W=5`, `M=90`, as a literal string.
  - `the grow light's rules are no conflict`:
    - Rule2 is the owner's exact grow-light rule (spec §4 and memory). Copy it from this plan's appendix A.
    - `chooseSlot({1:'', 2:growLight, 3:''})` returns `1`.
    - `conflicts(…, 1, {1:{Enable:1}, 2:{Enable:1}, 16:{Enable:0}}, {}, memsFor(cfg))` returns `[]`.
  - `a foreign rule using RuleTimer7 is a conflict`, and `RuleTimer70 is not`.
  - `our own slot is found again`: `chooseSlot({1:'x', 2:growLight, 3:ruleText(cfg)})` returns `3`.
  - `no free slot → null`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/rules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `rules.ts`.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): the Threadgarden rule for Tasmota switches`.

### Task 4: `PowerSwitch` — Tasmota switch

**Files:**
- Create: `packages/service/src/power/switch.ts`
- Test: `packages/service/test/power/switch.test.ts`

**Interfaces:**
- **Consumes:** `TasmotaClient` (Task 2); `ruleText`, `memsFor`, `commandsFor`, `chooseSlot`, `conflicts`, `isOurs` (Task 3).
- **Produces:**
  ```ts
  export interface PowerSwitch {
    reading(): Promise<PlugReading>;          // sends `read`, waits 1.5 s, then ZbStatus3 <device> / Status 8
    setPower(on: boolean): Promise<void>;
    ensureInstalled(): Promise<void>;         // slot + Mem11–14 + SetOption83 1 (Zigbee) + rule on; idempotent; POWER_CONFLICT with the problems
    uninstall(): Promise<void>;               // clears our slot, Mem11–14 and Timer16; nothing else
    armCut(): Promise<void>;                  // ensureInstalled, then `Event tga`
    disarm(): Promise<void>;                  // `Event tgo`
    armWake(atMs: number | null): Promise<void>; // Timer16 for local(at) on that weekday, Repeat 0, Action 3; null → Enable 0
    cycle(): Promise<void>;                   // `Event tgw`
    lastCut(): Promise<number | null>;        // Mem11 seconds → ms; '0' or '' → null
  }
  export function createSwitch(config: PowerConfig, password: string, o?: { fetch?: typeof fetch }): PowerSwitch;
  ```
- **SetOption83 on a Zigbee bridge.** `ensureInstalled` sets `SetOption83 1` only if it is off and no other slot contains `ZbReceived#0x`. Otherwise it reports `POWER_CONFLICT`: "Another rule on this bridge names Zigbee devices by address; Threadgarden needs names (SetOption83 1)".
- **The wake time.** It is computed from `Status 7`: device local minus UTC gives the offset. The timer is set to `local(atMs - 5 min)` as `HH:MM`, with `Days` having only that weekday set (Tasmota `Days` starts on Sunday).

- [ ] **Step 1: Write the failing tests** (against `startFakeTasmota`):
  - `installs into a free slot and leaves the grow light alone`:
    - The fake starts with Rule2 = growLight (on), Timer1 and Timer2 enabled, and Var1 = `'x'`.
    - After `ensureInstalled()`: `fake.rules[1].text === ruleText(cfg)` and on; Rule2, Timer1, Timer2 and Var1 are unchanged; `fake.mems` 11–14 equal `memsFor(cfg)`.
  - `ensureInstalled twice sends no Rule write the second time` (it compares the text first).
  - `uninstall clears only ours`: Rule1 is empty, Mem11–14 are empty and Timer16 has `Enable 0`; Rule2 is unchanged.
  - `conflict is reported, nothing written`: a foreign Rule3 uses `Var15`, so `ensureInstalled()` rejects with `POWER_CONFLICT`, and `fake.commands` contains no `Rule1 ` write.
  - `reading` returns `{on: true, watts: 47}` when the fake device reads 47 W.
  - `armWake: device at UTC+1`: for a send due `2026-11-02T02:00:00Z`, Timer16 gets `Time: "02:55"` and `Days: "0100000"` (Monday; Tasmota's `Days` runs Sunday to Saturday, as in the owner's `"1111111"`). The same send with the device at UTC+2 gets `"03:55"`.
  - `lastCut` returns `1793545231000` when Mem11 is `'1793545231'`, and `null` when it is `'0'`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/switch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `switch.ts`.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): a Tasmota power switch that shares the bridge politely`.

### Task 5: Probing a switch and pairing a plug

**Files:**
- Create: `packages/service/src/power/probe.ts`
- Test: `packages/service/test/power/probe.test.ts`

**Interfaces:**
- **Produces:**
  - `probeSwitch(address: string, password: string, o?: {fetch?}) → Promise<ProbeResult>`:
    - It reads `Status 2`. Below `MIN_TASMOTA` it fails with `POWER_TOO_OLD`.
    - It then tries `ZbStatus1`. A device list means `tasmota-zigbee`. For each device it reads ActivePower once, waits 1.5 s, then runs `ZbStatus3`; `metering` is true when `ActivePower` is present.
    - On `Unknown`, it runs `Status 8`. An `ENERGY.Power` value means `tasmota-plug`, and `plug` is filled.
    - Otherwise it fails with `POWER_NO_METERING`.
  - `pairPlug(address, password, o?: {fetch?, timeoutMs?: 60000, pollMs?: 3000}) → Promise<SwitchDevice | null>`:
    - It runs `ZbPermitJoin 1`, then polls `ZbStatus1` until a device appears that was not in the first list.
    - It always ends with `ZbPermitJoin 0`.
  - `renameDevice(address, password, id, name) → Promise<void>` sends `ZbName <id>,<name>`.

- [ ] **Step 1: Write the failing tests.**
  - `zigbee bridge with a metering plug and a non-metering device`: the result has `kind: 'tasmota-zigbee'` and two devices, with `metering` true and false.
  - `plug kind`: `kind: 'tasmota-plug'` and `plug.watts === 47`.
  - `too old`: version `'12.5.0'` gives `POWER_TOO_OLD`.
  - `pairPlug returns the new device and closes pairing`: `fake.joinNext(…)` after 2 polls returns the device; the last pairing command is `ZbPermitJoin 0`.
  - `pairPlug times out → null and closes pairing`, using a `timeoutMs` of 100.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/probe.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): recognise a Tasmota switch and pair a plug`.

### Task 6: Client side — configurations, readings, turning on

**Files:**
- Create: `packages/service/src/power/hub.ts`, `packages/service/src/server/handlers/power.ts` (client handlers)
- Modify: `packages/service/src/history/migrations.ts`, `packages/service/src/main.ts`
- Test: `packages/service/test/power/hub.test.ts`, `packages/service/test/server/local-only.test.ts`

**Interfaces:**
- **Consumes:** `createSwitch` (Task 4); `probeSwitch`, `pairPlug`, `renameDevice` (Task 5).
- **Produces:**
  - **Migration (appended):** `CREATE TABLE IF NOT EXISTS machine_power (machine_id TEXT PRIMARY KEY, config TEXT NOT NULL)`, holding the JSON of `PowerConfig`.
  - **`class PowerHub`:**
    - `constructor(db: Db, o?: {fetch?, now?: () => number})`
    - `list(): {machineId, config}[]`
    - `configure(machineId, config | null, password?)`: on `config`, it runs `ensureInstalled` and stores the config. On `null`, it runs `uninstall` (when the password is known) and deletes the config.
    - `unlock(machineId, password)`
    - `reading(machineId)`: cached for 3 s, and `POWER_NOT_CONFIGURED` without a config or password.
    - `turnOn(machineId): {cycled, waitMs}`
    - `noteMeasurement(machineId, kind: 'running' | 'standby', watts)`: updates `measured`.
  - **The `turnOn` algorithm:**
    1. Read.
    2. If the plug is **on** and the watts are below `offWatts` (standby), run `cycle()` and return `{cycled: true, waitMs: minOff*1000}`.
    3. If the plug is **off**, run `lastCut()`. Set `waitMs = max(0, cut + minOff*1000 - now)` and return `{cycled: false, waitMs}` at once; the hub runs `setPower(true)` from its own timer after `waitMs`, so the request never waits. A second `turnOn` while one is pending returns the same pending result.
    4. If the plug is on and the watts are at or above the line, it is already running: return `{cycled: false, waitMs: 0}`.
  - **Handlers:** `power.probe`, `power.pairPlug`, `power.rename`, `power.configure`, `power.unlock`, `power.list`, `power.reading`, `power.turnOn` and `power.noteMeasurement`, all `localOnly`.

- [ ] **Step 1: Write the failing tests.**
  - `turnOn from standby cycles`: the fake device is on at 0 W, so the result is `{cycled: true}` and `fake.commands` ends with `Event tgw`.
  - `turnOn soon after a cut waits out the minimum off time`: Mem11 is now−30 s and `minOffSeconds` is 90. With manual timers, `ZbSend …Power:1` is sent only after 60 s, and `waitMs` is `60000`.
  - `turnOn when off long ago switches on at once`.
  - `reading is cached for 3 s`: two calls within 3 s send one `read`.
  - `configure(null) uninstalls and forgets`.
  - In `local-only.test.ts`, the nine client methods answer `FORBIDDEN` for `origin: 'remote'`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/hub.test.ts test/server/local-only.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and wire `registerPowerClientHandlers(router, {hub})` in `startService`.
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): the client side of power control`.

### Task 7: Power passwords in the OS keychain

**Files:**
- Modify: `apps/desktop/src-tauri/src/secrets.rs`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/lib/native.ts`
- Test: the `#[cfg(test)]` module in `secrets.rs`; `apps/desktop/tests/native.test.ts` (or the existing native test file)

**Interfaces:**
- **Produces:**
  - Rust: `power_password_get(machine_id) -> Option<String>`, `power_password_set(machine_id, password)`, `power_password_clear(machine_id)`. They use account `power:<uuid>` under service `"threadgarden"` and the same id validation as `machine_user()`.
  - TypeScript: `powerPasswords: { get(id): Promise<string | null>; set(id, pw): Promise<void>; clear(id): Promise<void> }`. Outside Tauri this is a `Map`, like `machineTokens`.

- [ ] **Step 1: Write the failing Rust test**, against the in-memory `Store`: `power_password_set` then `get` round-trips under the account `power:<id>`, and an invalid id is rejected. Also write the TypeScript test: `powerPasswords` falls back to a Map outside Tauri.
- [ ] **Step 2:** run `cargo test secrets` (in `apps/desktop/src-tauri`) and `pnpm --filter desktop exec vitest run tests/native.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and register the three commands in `lib.rs` with the `blocking()` helper.
- [ ] **Step 4:** run the same commands. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(desktop): keep power switch passwords in the OS keychain`.

### Task 8: Machine side — stored configuration, status, keep awake

**Files:**
- Create: `packages/service/src/power/store.ts`, `packages/service/src/power/idle.ts`
- Modify: `packages/service/src/server/handlers/power.ts` (machine handlers), `packages/service/src/main.ts` (capabilities and wiring)
- Test: `packages/service/test/power/store.test.ts`, `packages/service/test/power/idle.test.ts`

**Interfaces:**
- **Produces:**
  - **`class PowerStore`:**
    - `constructor(dataDir)`
    - `load(): {config, password} | null`
    - `save(config | null, password?)`, which writes `power-switch.json` with mode `0o600` (`fs.writeFileSync(…, {mode: 0o600})`, then `chmodSync` on POSIX) and deletes the file on `null`
  - **`class IdleMonitor`:**
    - `constructor(o: { sessions: () => {live: boolean; status: ChatStatus; runningTasks?: number}[]; external: () => {status?: 'busy' | 'waiting' | 'idle'}[]; minutes: () => number | null; now?: () => number })`
    - `tick(): void`
    - `busy: boolean`
    - `idleSince: number | null`
    - `shutsDownAt(): number | null`
    - `keepAwake: KeepAwake`
    - `setKeepAwake(k)`
    - `due(): boolean`
  - **What counts as busy:**
    - a session that is `live` and has a status in `IN_TURN` (`working`, `needsYou`, `unknown`);
    - or any session with `runningTasks > 0`;
    - or any external session with `status === 'busy'`.

    `needsYou` is in `IN_TURN`, but a session waiting on the owner is **idle** by spec §10. So `needsYou` counts as busy only while `runningTasks > 0`. Ruling: spec §10, "waiting on the owner counts as idle".
  - **`due()`** is true when the monitor is not busy, `minutes() !== null`, keep awake is not active, and `now - idleSince >= minutes*60000`.
  - **Handlers (open to paired devices):** `power.adopt`, `power.status`, `power.keepAwake`. They emit `power.changed` to every client on any change.
  - **Capabilities:** `hello` advertises `power` only when the service is `headless`.

- [ ] **Step 1: Write the failing tests.**
  - `store writes 0600 and never returns the password through status`: skip the mode check on win32. `power.status` contains no `password` field anywhere.
  - `idle: needsYou without running tasks is idle; working is busy; an external busy session is busy`.
  - `due after 60 idle minutes, not before; keepAwake 'always' blocks; 'until' expires`.
  - `capabilities include power only when headless`: use `startService({headless: true, …})` and the `hello` result.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/store.test.ts test/power/idle.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, and call `idle.tick()` from the existing minute tick in `main.ts` (around :876).
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): idle tracking and power settings on a headless machine`.

### Task 9: Push check

**Files:**
- Create: `packages/service/src/power/push-check.ts`
- Test: `packages/service/test/power/push-check.test.ts`

**Interfaces:**
- **Produces:**
  - `checkUnpushed(dirs: {cwd: string; sessionId: string | null}[], o?: {git?: (args: string[], cwd: string) => Promise<string>}) → Promise<Unpushed[]>`
  - `git` defaults to `execFile('git', args, {cwd, timeout: 10000, windowsHide: true})`, the pattern from `files/file-index.ts:51`.
- **Algorithm, per directory:**
  1. Run `rev-parse --show-toplevel` and skip directories that fail.
  2. Deduplicate by top level. Worktrees are separate top levels, so they are checked separately, as the spec wants.
  3. Run `remote`. An empty answer means skip: local only, which plan 2 handles.
  4. Run `status --porcelain=v1 -z --untracked-files=normal`. A non-empty answer gives `{kind: 'uncommitted', count: <entries>}`.
  5. Run `for-each-ref --format=%(refname:short) refs/heads`. For each branch, run `rev-list --count <b> --not --remotes`; a count above 0 gives `{kind: 'unpushed', branch, count}`.
  6. `sessionId` is the given session of the most recent chat in that repo.
- **Directories come from the history catalog:** the distinct `cwd` of every session on this machine, newest first (one query on the index).

- [ ] **Step 1: Write the failing tests**, with real git in temporary directories (skipped when `git` is not on PATH):
  - a clean clone, pushed to a bare remote, gives `[]`;
  - an untracked non-ignored file gives `uncommitted`, `count 1`;
  - an ignored file gives `[]`;
  - a local commit not pushed gives `unpushed`, `branch main`, `count 1`;
  - a new branch with no upstream and one commit gives `unpushed`;
  - a repo with no remote gives `[]`;
  - a missing directory gives `[]`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/push-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(service): find work that never reached GitHub`.

### Task 10: The shutdown sequence

**Files:**
- Create: `packages/service/src/power/shutdown.ts`
- Modify: `packages/service/src/server/handlers/power.ts` (`power.shutdown`), `packages/service/src/main.ts`
- Test: `packages/service/test/power/shutdown.test.ts`

**Interfaces:**
- **Consumes:**
  - `PowerStore`, `IdleMonitor` (Task 8)
  - `checkUnpushed` (Task 9)
  - `createSwitch` (Task 4)
  - `ScheduledSends.list()` (`usage/scheduled.ts`)
  - `SessionHost.stopAll()` (`chat/session-host.ts:150`)
- **Produces:**
  - `class ShutdownSequence { constructor(o: { store; idle; dirs: () => {cwd; sessionId}[]; scheduled: () => {sendAt: number; state: string}[]; stopAll: () => Promise<void>; poweroff: () => Promise<void>; makeSwitch?: typeof createSwitch; now?; emit: (s: MachinePowerStatus) => void }); status(): MachinePowerStatus; run(o: {force: boolean; reason: 'idle' | 'manual'}): Promise<MachinePowerStatus>; onStart(): Promise<void> }`
  - `poweroff` defaults to `execFile('systemctl', ['poweroff'])`.
- **`run` order:**
  1. Set `phase: 'checking'`.
  2. **Push check**, skipped with `force`. If anything is found: set `phase: 'blocked'` with `unpushed`, emit, and return. The idle clock restarts (`idle.idleSince = now`).
  3. **Next scheduled send.** Take the earliest pending send. If it is due within **15 min**, don't shut down: set `phase: 'running'` and `problem: 'A scheduled message is due soon'`, then return. Ruling: a wake that would fire before the machine is even off is pointless.
  4. **Arm the switch.** Run `makeSwitch(...).armCut()`, then `armWake(earliest?.sendAt ?? null)`. **If either throws, do not power off.** Set `phase: 'running'`, set `problem` to the error's plain message (for example "The power switch at 192.168.1.106 refused the password"), emit, and return. This is Review Focus 2.
  5. Set `phase: 'shuttingDown'`, emit, run `await stopAll()`, then `await poweroff()`.
- **`onStart()`** runs at service start. If configured, it runs `disarm()` and `armWake(null)`, ignoring errors. This is Review Focus 1.
- **The idle trigger:** the minute tick calls `run({force: false, reason: 'idle'})` when power is configured (`store.load()` is not null), `idle.due()`, and the phase is `running`. Without a configured switch, a headless machine never shuts itself down.
- **`power.shutdown {force}`** calls `run({force, reason: 'manual'})`.

- [ ] **Step 1: Write the failing tests**, with fakes for every dependency and `startFakeTasmota`:
  - `clean machine: arms the cut, then stops sessions, then powers off`: the call order is `[Event tga, stopAll, poweroff]`.
  - `unpushed work blocks: no arm, no poweroff, phase blocked`.
  - `force skips the push check`.
  - `switch refuses the password: no poweroff, problem set, phase running`.
  - `a send due in 10 min: no shutdown`.
  - `a send due in 3 h: Timer16 armed for 5 min before, then poweroff`.
  - `onStart disarms`: `fake.commands` contains `Event tgo` and a `Timer16` with `Enable 0`.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/power/shutdown.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement and wire.** Wire it only when `headless`, with `ScheduledSends` and `SessionHost` from `startService`.
- [ ] **Step 4:** run the same command. Expected: PASS. Then run `pnpm --filter @threadgarden/service test`. Expected: the whole suite passes.
- [ ] **Step 5: Commit** with `feat(service): idle shutdown with push check, armed cut and wake`.

### Task 11: Packaging — the right to power off

**Files:**
- Modify: `packaging/headless/install.sh`, `packages/service/test/packaging/install.test.ts`, `docs/remote-machines.md` (Uninstalling)

**Interfaces:**
- **Produces:** `install.sh` writes `${POLKIT_RULES_DIR:-/etc/polkit-1/rules.d}/49-threadgarden-power.rules` through `$SUDO tee`, after explaining why, the same way it handles linger. Ctrl+C skips it, with a warning that idle shutdown will then fail. The content, with `USER` substituted:
  ```js
  // Lets the Threadgarden service of USER power the machine off (idle shutdown).
  polkit.addRule(function (action, subject) {
    if ((action.id == "org.freedesktop.login1.power-off" ||
         action.id == "org.freedesktop.login1.power-off-multiple-sessions") &&
        subject.user == "USER") {
      return polkit.Result.YES;
    }
  });
  ```

- [ ] **Step 1: Write the failing test** in `install.test.ts`, using the existing stand-ins: after install, the file under `POLKIT_RULES_DIR` contains `subject.user == "<test user>"` and both action ids.
- [ ] **Step 2:** run `pnpm --filter @threadgarden/service exec vitest run test/packaging/install.test.ts` (on Linux or macOS; it skips on win32). Expected: FAIL.
- [ ] **Step 3: Implement.** Add a line to the Uninstalling section: `sudo rm /etc/polkit-1/rules.d/49-threadgarden-power.rules`.
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(packaging): let the headless service power the machine off`.

### Task 12: UI state — power and machine states

**Files:**
- Create: `apps/desktop/src/lib/state/power.svelte.ts`
- Modify: `apps/desktop/src/lib/state/machines.svelte.ts` (`MachineStatus`, unlock, adopt sync), `apps/desktop/src/lib/state/app.ts`, `apps/desktop/src/lib/state/context.ts`, `apps/desktop/tests/layout/harness.ts`
- Test: `apps/desktop/tests/state/power.test.ts`

**Interfaces:**
- **Consumes:**
  - the local `Api` (`power.*` client methods);
  - each machine's `client` (`power.status`, `power.adopt`, `power.keepAwake`, `power.shutdown`, and the `power.changed` event);
  - `powerPasswords` (Task 7).
- **Produces:**
  - `MachineStatus` gains `'off' | 'starting' | 'shuttingDown'`. The exhaustive switch in `MachineHeading.machineState` gets their labels: **Off** (red), **Starting…** (amber), **Shutting down** (amber).
  - **`class PowerState`:**
    - `init(localApi, machines)`
    - `config(id): PowerConfig | null`
    - `reading(id): PlugReading | null`
    - `machine(id): MachinePowerStatus | null`
    - `status(id, link: MachineStatus): MachineStatus`
    - `turnOn(id)`, `shutDown(id, force)`, `keepAwake(id, k)`, `configure(id, config | null, password?)`
    - `visible(v: boolean)`
  - **`status()` derivation, with power configured:**
    - link `on` with `machine.phase === 'shuttingDown'` is **shuttingDown**;
    - link `on` otherwise is **on**;
    - link not on, with the reading off or below the line, is **off**;
    - link not on, with watts at or above the line, is **shuttingDown** if the last seen phase was `shuttingDown` less than 3 min ago; **starting** if a `turnOn` began less than 5 min ago; otherwise **unreachable**;
    - no reading leaves the link status unchanged.
  - **Polling (`power.reading`, local only):**
    - every **5 s** while a machine is starting or shutting down;
    - otherwise every **60 s** while the window is visible;
    - **never** while hidden. Anti-goal: no busy loops on the main PC.
  - **Measurements:**
    - a reading taken while the link is `on` calls `power.noteMeasurement` with `kind: 'running'`;
    - the first reading below the line after `shuttingDown` calls `power.noteMeasurement` with `kind: 'standby'`.

  - **Adopt sync:** when a machine connects with the `power` capability and `machine.configured` is false while a local config exists, call `power.adopt` with the config and the keychain password.
  - **Unlock:** after `machines.unlock` on each local open, call `power.unlock` for every machine with a stored password.

- [ ] **Step 1: Write the failing tests** (harness `setupTwoMachines`, `FakeServer` handlers for `power.*`):
  - `off when the link is down and the plug reads 0 W`.
  - `starting after turnOn while watts rise; unreachable after 5 min`.
  - `shutting down: phase shuttingDown, then link lost at 46 W still shows Shutting down, then Off at 0 W`. This is Review Focus 5.
  - `adopt is sent once when the machine lacks the config`.
  - `polls every 5 s while starting, 60 s otherwise, not at all while hidden`, with fake timers counting `power.reading` calls.
- [ ] **Step 2:** run `pnpm --filter desktop exec vitest run tests/state/power.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run `pnpm --filter desktop exec vitest run tests/state`. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(ui): machine power states`.

### Task 13: UI — the ⏻ menu and the Off group

**Files:**
- Modify: `apps/desktop/src/lib/components/layout/MachineHeading.svelte`, `apps/desktop/src/lib/components/layout/PlacesColumn.svelte`
- Test: `apps/desktop/tests/layout/power-menu.test.ts`

**Interfaces:**
- **Consumes:** `PowerState` (Task 12).
- **Produces:**
  - A **⏻ button** (`aria-label="Power for ‹name›"`) on the heading of each machine with power configured. It opens a menu, using the same menu primitive as the project rows (PlacesColumn :198–242):
    - **Turn on**, while off or unreachable;
    - **Shut down now**, while on: `shutDown(id, false)`, which may end in the unpushed notice;
    - **Keep awake**, while on: a submenu with **For 1 hour**, **For 4 hours**, **Until I turn it off** and **Stop keeping awake**.
  - **The countdown:** the heading's `title` for an On machine with `shutsDownAt` reads "Shuts down in 42 min". With keep awake it reads "Kept awake until 18:40" or "Kept awake".
  - **The Off group:** an off machine's group shows only its heading and one muted line: **"Its chats appear once it's on."**

- [ ] **Step 1: Write the failing tests:**
  - `Turn on calls power.turnOn`;
  - `Shut down now calls power.shutdown {force:false}`;
  - `Keep awake → For 1 hour sends power.keepAwake {mode:'until', until: now+3600000}`;
  - `an off machine shows the placeholder and no project rows`;
  - `title shows Shuts down in 42 min`;
  - `no ⏻ without power config`.
- [ ] **Step 2:** run `pnpm --filter desktop exec vitest run tests/layout/power-menu.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(ui): the power menu on machine headings`.

### Task 14: UI — power setup in Settings

**Files:**
- Create: `apps/desktop/src/lib/components/PowerSettings.svelte`, `apps/desktop/src/lib/components/PowerSetupDialog.svelte`
- Modify: `apps/desktop/src/lib/components/MachinesSettings.svelte` (one `<PowerSettings machine=…/>` per paired machine card)
- Test: `apps/desktop/tests/layout/power-settings.test.ts`

**Interfaces:**
- **Consumes:** `PowerState` (Task 12); the local `power.probe`, `power.pairPlug` and `power.rename`; `powerPasswords`.
- **Produces:** a **Power** subsection in each paired machine's card. It appears only when the machine has the `power` capability. When the machine is not On, it reads "Connect the machine once to set up power control".
  - **Unconfigured:** a **Set up power control…** button that opens the dialog.
  - **Dialog step 1, "Connect":**
    - fields **Address** and **Password**, with the note "User name is always admin";
    - **Connect** runs `power.probe`;
    - errors are mapped to plain sentences, one per `POWER_ERRORS` code. For `POWER_REFUSED`: "The switch refused Threadgarden's request. On its page, Consoles → Console, run SetOption128 1, then try again."
  - **Dialog step 2, "Choose the plug"** (Zigbee only):
    - one radio per device with `metering`, labelled `‹name or id› — 47 W`;
    - **Pair a new plug…** runs `power.pairPlug` with the hint "Hold the plug's button for 5 seconds until its LED blinks fast" and a 60 s countdown; the new device is named through `power.rename` with "‹machine› plug";
    - for a plug kind, this step is skipped, and the Experimental label is shown.
  - **Dialog step 3, "Check":**
    - live watts, refreshed every 5 s while the dialog is open;
    - **Off below** (W, default 5) and **Wait before switching on** (s, default 90);
    - no button switches the plug off.
  - **Save:** `powerPasswords.set` → `power.configure` → `power.adopt` on the machine. A `POWER_CONFLICT` error shows its problems as a list.
  - **Configured:**
    - kind, address, plug, live watts, Off below, Wait before switching on;
    - a suggestion "Measured: 47 W running, 0 W shut down — suggest off below 12 W [Use]", when both measurements exist and the suggestion differs. The suggestion is `Math.max(2, Math.round(standby + (running - standby) / 4))`;
    - **Shut down after idle**, a select of **Never**, **30 min**, **1 hour**, **2 hours** and **4 hours**, bound to the machine's `idleShutdownMinutes` through `settings.set` on the machine client;
    - **Remove power control** (`ConfirmDialog`) runs `power.configure(id, null)`, `power.adopt({config: null})` and `powerPasswords.clear`.

- [ ] **Step 1: Write the failing tests:**
  - `connect → choose → save sends probe, configure, adopt in order and stores the password`;
  - `wrong password shows the auth sentence`;
  - `POWER_CONFLICT lists the problems`;
  - `suggestion appears and Use sets offWatts 12`;
  - `idle select writes idleShutdownMinutes 120 to the machine`;
  - `remove clears config, adopt null, keychain`.
- [ ] **Step 2:** run `pnpm --filter desktop exec vitest run tests/layout/power-settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(ui): guided power setup in Settings`.

### Task 15: UI — unpushed work in Needs you

**Files:**
- Create: `apps/desktop/src/lib/components/UnpushedNotice.svelte`
- Modify:
  - `apps/desktop/src/lib/components/layout/PlacesColumn.svelte` (the Needs you count);
  - the Needs you list view: the component that renders `place.kind === 'needsYou'`, through `merged-list.svelte.ts`;
  - `apps/desktop/src/lib/notifications.ts`
- Test: `apps/desktop/tests/layout/unpushed.test.ts`

**Interfaces:**
- **Consumes:** `PowerState.machine(id)` (Task 12): `phase === 'blocked'` and `unpushed`.
- **Produces:**
  - **The notice:** one per blocked machine, at the top of the Needs you list, titled **"Unpushed work on ‹machine›"**.
    - It lists each item: "‹repo›: 3 uncommitted changes" or "‹repo› ‹branch›: 2 commits not on GitHub".
    - **Ask Claude to push it** sends "Please commit and push your work in ‹repo› so the machine can shut down." to `item.sessionId`, through the existing send path for that machine's scope.
    - **Shut down anyway** runs `power.shutdown {force: true}`.
  - **The count:** the Needs you count adds one per blocked machine.
  - **The notification:** one per transition into `blocked`, "Unpushed work on ‹machine› — shutdown is paused", through the machine's attention source.

- [ ] **Step 1: Write the failing tests:**
  - `blocked machine shows the notice first and bumps the count`;
  - `Ask Claude to push it sends the message to the session`;
  - `Shut down anyway sends force`;
  - `notification fires once per blocked transition`.
- [ ] **Step 2:** run `pnpm --filter desktop exec vitest run tests/layout/unpushed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run `pnpm --filter desktop test`. Expected: the whole desktop suite passes.
- [ ] **Step 5: Commit** with `feat(ui): unpushed work pauses shutdown and asks you`.

### Task 16: Docs, mock and e2e

**Files:**
- Modify:
  - `packages/service/src/testing/mock-main.ts`: `--fake-tasmota` starts `startFakeTasmota({kind: 'zigbee'})` with one device `MockPlug` at 47 W and prints its address;
  - `apps/desktop/e2e/env.ts`, `apps/desktop/e2e/playwright.config.ts`: start the remote mock with `--fake-tasmota`;
  - `docs/remote-machines.md`, `docs/architecture.md`, `README.md`, `CONTRIBUTING.md`.
- Create: `apps/desktop/e2e/power.spec.ts`

**Interfaces:**
- **`docs/remote-machines.md`:**
  - Replace "Not yet: turning the PC on and off…" (lines ~24–29) with a link to a new section **"4. Power control"**. That section holds:
    - **4.1 Choose a switch:** a Tasmota Wi-Fi plug with power metering (Experimental), or a ZB Bridge-P with a Zigbee plug.
    - **4.2 Prepare a ZB Bridge-P:** spec §12 step 1, as numbered steps with the esptool command `python -m esptool --port COMx --baud 460800 --before no-reset --after no-reset write-flash --erase-all 0x0 tasmota32-zbbrdgpro.factory.bin`, Wi-Fi over serial, the Zigbee chip update, the web password and the address reservation.
    - **4.3 The BIOS:** AC Back / Restore on AC power loss = On, and test it with more than 10 s unplugged.
    - **4.4 In Threadgarden:** the guided setup.
    - **4.5 What Threadgarden changes on your switch:** the resources from Global Constraints, and that nothing else is touched.
    - **4.6 Security:** no TLS on Tasmota, so keep the switch on your LAN, behind the router, and use its web password.
  - Add the `gh auth login --insecure-storage` note and "a first headless boot can take a few minutes" (from the Notion bug list).
  - Troubleshooting rows: "Starting… then Unreachable", "Shutdown paused: unpushed work", "The power switch refused the password", "Stays Off after Turn on", the last one covering the BIOS setting and the minimum off time.
- **`docs/architecture.md`:** a **Power** paragraph under Machines (:569), covering the switch interface, who owns what (client hub against machine sequence), the rule, polling cadence and the security of the password. Update ":575 not yet power control". Add the client power methods to the local-only list (~:230).
- **`README.md`:** one line under features, "Turns a remote machine on and off through a Tasmota smart plug".
- **`CONTRIBUTING.md`:** add the local-only power methods if that file lists local-only methods.
- **`power.spec.ts`:** pair the remote mock (existing helper), then Settings → Power → Connect to the fake → choose `MockPlug` → Save. The heading shows the ⏻ button, and the Power section shows `47 W`.

- [ ] **Step 1: Write the failing e2e spec.**
- [ ] **Step 2:** run `pnpm --filter desktop test:e2e -- power.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the mock flag and write the docs.**
- [ ] **Step 4:** run `pnpm --filter desktop test:e2e`, then `pnpm test`, `pnpm typecheck` and `pnpm lint`. Expected: everything passes.
- [ ] **Step 5: Commit** with `docs: power control setup and architecture; e2e for the power setup`.

### Task 17: Acceptance on the owner's hardware (with the owner)

This task is manual. It runs after the branch builds, using the owner's real bridge (192.168.1.106, plug `UbuntuPlug`, grow light on Timer1, Timer2 and Rule2) and the Ubuntu PC. It needs a headless package built from the branch, installed on the Ubuntu PC the usual way (`install.sh`, accepting the polkit step), and a desktop build of the branch on Windows.

- [ ] **Step 1: Set up power control** in Settings for the Ubuntu PC. Expected:
  - the plug is listed with live watts;
  - Save succeeds;
  - on the bridge's page, `Rule1` holds Threadgarden's rule, `"State":"ON"`. It is compressed, and its text is identical when read back;
  - Rule2, Timer1 and Timer2 are unchanged.
- [ ] **Step 2: Turn on from Off** (plug cut earlier). Expected: Starting…, then On within ~1 min.
- [ ] **Step 3: Test the push check.** Create an untracked file in a repo with a chat, then Shut down now. Expected: the notice. Then **Shut down anyway**. Expected: Shutting down, then Off, with the plug cut about 30 s after 0 W.
- [ ] **Step 4: Test idle shutdown.** Set Shut down after idle to 30 min with no chat working. Expected: the machine powers off by itself and the plug is cut.
- [ ] **Step 5: Test the wake.** Schedule a message in a chat for about 40 min ahead, then shut down. Expected: Timer16 is armed 5 min before. The PC boots, the message is sent, and the PC later idles off.
- [ ] **Step 6: Test the press-the-button case.** Arm a shutdown, then press the PC's power button as soon as it's off. Expected: the PC runs and is never cut, because the arm is disarmed at service start.
- [ ] **Step 7:** record the results in the PR description. Any failure becomes a fix task before merge.

---

## Appendix A — the owner's grow-light rule (exact, for tests)

```
on Clock#Timer=1 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on Clock#Timer=2 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon on Time#Initialized do RuleTimer3 30 endon on Rules#Timer=3 do event growlight=%time% endon on event#growlight>=360 do ZbSend {"Device":"GrowLight","Send":{"Power":1}} endon on event#growlight<360 do ZbSend {"Device":"GrowLight","Send":{"Power":0}} endon
```
Timer1 is `{"Enable":1,"Mode":0,"Time":"06:00","Window":0,"Days":"1111111","Repeat":1,"Action":3}`; Timer2 is the same with `"Time":"00:00"`.
