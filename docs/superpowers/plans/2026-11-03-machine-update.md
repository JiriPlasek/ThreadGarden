# Update a machine from the desktop: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings shows every machine's version. One click updates a headless machine to the latest release, and if it doesn't come up, it rolls back by itself.

**Architecture:**
- **The machine's service does the update.** It downloads the versioned headless tarball from GitHub, checks its sha256 and unpacks it. Then it launches a small apply script in a transient systemd user unit, so the script survives the service's own restart.
- **The apply script** runs the new `install.sh` without prompts and waits for the new service to report itself started, or rolls back.
- **The outcome lands in a status file** the new (or restored) service reports through `update.status`.
- **The desktop** learns the latest version through its local service (`update.latest`; the webview's CSP blocks GitHub). It keeps every machine's last seen version and drives the click.
  - The click means: bring an Off machine up, prompt if it's busy, follow the stages, then confirm the new version after reconnecting.

**Tech Stack:**
- the Node 22 service (global `fetch`, `node:crypto`, `execFile`), with zod in `@threadgarden/protocol`;
- Svelte 5 runes in the desktop;
- POSIX `sh` for the apply script;
- Vitest and Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-machine-update-design.md`

## Global Constraints

- **Protocol:**
  - `PROTOCOL_VERSION = 10`; `REMOTE_PROTOCOL_RANGE = { min: 9, max: 11 }`; the Rust copy in `apps/desktop/src-tauri/src/service.rs` goes to 10.
  - Keep the literal `PROTOCOL_VERSION = 10;` in `version.ts`, which the Rust test greps.
  - Capability `'update'` (`UPDATE_CAPABILITY`). It's offered only when the service is headless, on Linux, and `~/.local/share/threadgarden-headless/current` exists.
- **Target:** always the latest release, the `version` field of `https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/latest.json`.
- **Downloads:**
  - `https://github.com/JiriPlasek/ThreadGarden/releases/download/v<version>/threadgarden-headless-<version>-linux-x64.tar.gz` and `.sha256`.
  - HTTPS only. Start at `github.com`, and follow redirects only to hosts that are `github.com` or end in `.githubusercontent.com`, at most 5.
- **Version strings** must match `^[A-Za-z0-9][A-Za-z0-9.+_-]*$` (install.sh's rule) before they touch a path.
- **No prompts on the machine:** `install.sh` runs with `SUDO="sudo -n"`.
- **Start timeout:** the apply script waits **90 s** for the new version to report itself started, then rolls back.
- **Quiet UI:** only a dot on the Settings button(s). No Needs you entry, no chip, no banner.
- **Copy:**
  - card: `Threadgarden <v>`, `· <latest> available`, button `Update to <latest>`;
  - This PC: `This PC · Threadgarden <appVersion>`;
  - stages: `Turning on…`, `Downloading <v>…`, `Installing…`, `Restarting…`; done `Threadgarden <v> ✓`;
  - off without power control: button disabled plus `Turn it on to update`;
  - too old for this feature: `Update it over SSH this once` linking `https://github.com/JiriPlasek/ThreadGarden/blob/main/docs/remote-machines.md#upgrading`.
- **Busy prompt:**
  - title `Update <name> now?`
  - body `Claude is working in <n> chat(s) on <name>. Updating restarts Threadgarden there and stops them.` (singular "1 chat").
  - extra line while This PC has its own update: `This PC has an update too; install it as well so they keep talking.`
  - confirm button `Update anyway`.
- **Failure lines:**

  | reason | line |
  |---|---|
  | download | `Couldn't download <v> from GitHub` |
  | checksum | `The download's checksum didn't match` |
  | unpack | `The download was damaged` |
  | install | `Installing <v> failed; <name> is back on <from>` |
  | start | `<v> didn't start; <name> is back on <from>` |
- **Skipped-step notes:**
  - polkit: `Updated. Idle shutdown can't power <name> off until you run ~/.local/share/threadgarden-headless/current/install.sh once over SSH.`
  - linger: `Updated. Threadgarden won't start at boot on <name> until you run ~/.local/share/threadgarden-headless/current/install.sh once over SSH.`
- **Frozen methods:** `update.start` and `update.status` must stay callable from any later desktop. Their params and results may only gain optional fields, never change or lose one.
- **Repo conventions:**
  - `pnpm --config.verify-deps-before-run=false` for every pnpm command;
  - no Claude attribution in commits;
  - commit per task.

## Review Focus

1. **The desktop is closed or restarted mid-update.** Reopening Settings shows the outcome (✓ or the failure line) from `update.status`, not a stuck "Restarting…". Test: Task 8 `restores a finished update's outcome after a desktop restart`.
2. **The network drops mid-download.** The update fails with `download`, the old version keeps running, and the download folder is removed. Test: Task 5 `a failed download leaves nothing behind and reports download`.
3. **Two desktops press Update at once.** The second gets `UPDATE_RUNNING` and shows the running stage instead of an error. Tests: Task 5 `a second start while running is refused with UPDATE_RUNNING`; Task 8 `UPDATE_RUNNING follows the running update`.
4. **A machine two protocol versions behind** ("Different Threadgarden version") still shows its version and Update, and the update works. Tests: Task 7 `an incompatible hello still records version and updatability`; Task 8 `updates an incompatible machine through an update-only client`.
5. **GitHub is unreachable for the latest check.** There's no dot, no "available", and no error shown. The next scheduled check tries again. Test: Task 8 `an unreachable latest check shows nothing and retries on schedule`.

---

## File Structure

**Protocol**
- `packages/protocol/src/update.ts` (new): `UPDATE_CAPABILITY`, `UpdateStageSchema`, `UpdateStatusSchema`, `UpdateStartResultSchema`, `UPDATE_ERRORS`, `VERSION_PATTERN`.
- `packages/protocol/src/methods.ts`, `events.ts`, `version.ts`, `machines.ts`, `index.ts`: wiring.

**Packaging**
- `packaging/headless/install.sh`: write skipped sudo steps to `$THREADGARDEN_SKIPPED_FILE` when set.

**Service**
- `packages/service/src/update/github.ts` (new): `fetchChecked`, `latestRelease` (cached).
- `packages/service/src/update/apply-script.ts` (new): `APPLY_SCRIPT` (sh source) and `applyArgs`.
- `packages/service/src/update/updater.ts` (new): `MachineUpdater` (start, status, startup reconciliation, busy count).
- `packages/service/src/server/handlers/update.ts` (new): `registerUpdateHandlers`.
- `packages/service/src/main.ts`: build the updater, add the capability, register handlers, reconcile on startup.
- `packages/service/src/testing/mock-main.ts`: simulated update.

**Desktop**
- `apps/desktop/src/lib/service/client.ts`: keep the hello of an incompatible service.
- `apps/desktop/src/lib/state/machines.svelte.ts`: `version` and `canUpdate` on `MachineEntry`; remembered versions; `openForUpdate`.
- `apps/desktop/src/lib/state/bring-up.ts` (new): `bringUp` and `waitUntilOn`, moved out of `move/move-chat.svelte.ts`.
- `apps/desktop/src/lib/state/machine-updates.svelte.ts` (new): `MachineUpdatesState`.
- `apps/desktop/src/lib/components/MachinesSettings.svelte`, `MachineUpdate.svelte` (new), `layout/PlacesColumn.svelte`, `layout/AppShell.svelte`.

**Docs**
- `docs/remote-machines.md`, `docs/architecture.md`, `CONTRIBUTING.md` (if it lists methods).

---

### Task 1: Protocol 10, the `update` methods and event

**Files:**
- Create: `packages/protocol/src/update.ts`, `packages/protocol/test/update.test.ts`
- Modify: `packages/protocol/src/{methods,events,version,machines,index}.ts`, `packages/protocol/test/{schemas,move,usage,projects}.test.ts` (version and range pins), `apps/desktop/src-tauri/src/service.rs:18`, `packages/service/test/server/local-only.test.ts`

**Interfaces:**
- Produces:
  - `UPDATE_CAPABILITY = 'update'`
  - `VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/`
  - `UpdateStage = 'downloading'|'installing'|'restarting'`
  - `SkippedStep = 'linger'|'polkit'`
  - `UpdateFailure = 'download'|'checksum'|'unpack'|'install'|'start'`
  - `UpdateStatus`, a union keyed by `state`:
    - `{state:'idle'}`
    - `{state:'running', version, from, stage}`
    - `{state:'done', version, from, skipped: SkippedStep[]}`
    - `{state:'failed', version, from, reason: UpdateFailure, detail?: string}`
  - `UpdateStartResult = {started: true} | {started: false, busy: number}`
  - `UPDATE_ERRORS = { NOT_SUPPORTED, UPDATE_RUNNING, ALREADY_CURRENT, INVALID_VERSION, UNREACHABLE }` (code strings equal their names)
  - methods:
    - `'update.latest': def(empty, z.object({version: z.string()}))`, registered local-only;
    - `'update.start': def(z.object({version: z.string(), force: z.boolean()}), UpdateStartResultSchema)`;
    - `'update.status': def(empty, UpdateStatusSchema)`;
  - event `'update.progress': UpdateStatusSchema`.

- [ ] **Step 1: Write the failing tests.** In `update.test.ts`:
  - `PROTOCOL_VERSION is 10 and the remote range is 9..11`;
  - `VERSION_PATTERN accepts 0.7.1 and 1.0.0-rc.1, rejects ../x, .hidden and an empty string`;
  - **`frozen: v10 update.start and update.status payloads keep parsing`.** It parses these literal samples, and each must succeed:
    - `{version:'0.7.1', force:false}`
    - `{started:false, busy:2}`
    - every `UpdateStatus` variant, plus one with an extra unknown field `{state:'idle', note:'x'}`
  - `methods lists update.latest, update.start, update.status` and `events lists update.progress`.

  Update the pins in `schemas.test.ts` (the method and event key lists) and in `move.test.ts`, `usage.test.ts` and `projects.test.ts` (version and range). In `local-only.test.ts`, add `update.latest` to the `forbidden` list, and assert `update.start` and `update.status` are **not** forbidden for a paired device.
- [ ] **Step 2: Run them.** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol test`. Expected: FAIL (missing exports, version 9).
- [ ] **Step 3: Implement.**
  - Schemas in `update.ts`. Status objects use `.passthrough()` or default zod object stripping, so unknown fields parse (the frozen rule).
  - Wire them into `methods.ts`, under a `// ── update (protocol 10) ── frozen: only optional additions` header, and into `events.ts`.
  - `version.ts`: the doc line `10 — update a machine: update.*, the update capability, update.progress`.
  - `machines.ts`: the range.
  - `service.rs` constant: 10.
  - `index.ts` exports.
- [ ] **Step 4: Run** protocol tests, service `test/server/local-only.test.ts` (it fails until Task 5 registers handlers; that's expected now, so mark the new assertions `it.todo` until Task 5 and convert them there), and `cargo test protocol_version` in `apps/desktop/src-tauri` with the cargo recipe. Expected: PASS.
- [ ] **Step 5: Commit** `feat(protocol): protocol 10 with update.* and the update capability`.

### Task 2: install.sh reports skipped sudo steps

**Files:** Modify `packaging/headless/install.sh` and `packages/service/test/packaging/install.test.ts`.

**Interfaces:** Produces: when `THREADGARDEN_SKIPPED_FILE` is set, install.sh appends one line per skipped step, `linger` or `polkit`. A missing polkit dir counts as `polkit`. Exit codes are unchanged.

- [ ] **Step 1: Failing tests** in `install.test.ts`, using the existing stubs pattern:
  - `a sudo that fails for lingering writes linger to THREADGARDEN_SKIPPED_FILE`;
  - `a sudo that fails for the polkit rule writes polkit`;
  - `a matching polkit rule and Linger=yes write nothing`;
  - `without THREADGARDEN_SKIPPED_FILE nothing is written and output is unchanged`.
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service exec vitest run test/packaging/install.test.ts`. Expected: FAIL. On Windows the file is skipped, so CI's Linux run is the gate. Note that in the report.
- [ ] **Step 3: Implement.** A `skip() { [ -z "${THREADGARDEN_SKIPPED_FILE-}" ] || echo "$1" >> "$THREADGARDEN_SKIPPED_FILE"; }` helper is called in the two failure branches and in the missing-dir branch. Ctrl+C skips count too.
- [ ] **Step 4: Run** the test again; PASS on Linux.
- [ ] **Step 5: Commit** `feat(packaging): install.sh names skipped sudo steps for the updater`.

### Task 3: The service learns the latest release

**Files:**
- Create: `packages/service/src/update/github.ts`, `packages/service/test/update/github.test.ts`.
- Modify `main.ts`: create the update handler file `server/handlers/update.ts` with `update.latest` only for now, local-only.

**Interfaces:**
- Produces:
  - `type Fetch = typeof fetch`.
  - `fetchChecked(url: string, deps: {fetch: Fetch}): Promise<Response>`:
    - follows redirects by hand (`redirect: 'manual'`);
    - throws `ServiceError('UNREACHABLE', …)` on a non-HTTPS URL, a disallowed host, more than 5 redirects, a network error or a non-2xx status.
  - `class LatestRelease { constructor(deps: {fetch: Fetch, now: () => number, ttlMs?: number}); get(): Promise<string> }`:
    - reads `latest.json`'s `version` and validates it against `VERSION_PATTERN`;
    - caches successes for `ttlMs` (default 10 min);
    - failures aren't cached.
  - `registerUpdateHandlers(router, deps)`, a growing deps bag: here `{latest: LatestRelease}`.

- [ ] **Step 1: Failing tests:**
  - `follows a redirect to release-assets.githubusercontent.com`;
  - `refuses a redirect to example.com`;
  - `refuses http://`;
  - `stops after 5 redirects`;
  - `latest reads version from latest.json and caches it for 10 minutes`;
  - `a failed latest is not cached`;
  - `a version failing VERSION_PATTERN is UNREACHABLE`;
  - `update.latest is local-only` (via `router.dispatch` with origin `remote` → `FORBIDDEN`).

  Use a fake `fetch` returning `new Response(...)` with `status: 302` and a `location` header.
- [ ] **Step 2: Run** `… --filter @threadgarden/service exec vitest run test/update/github.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `main.ts`:
  - add `StartOptions.update?: { fetch?: Fetch; latest?: LatestRelease; … }` (the seam);
  - register the handlers after the router exists. `update.latest` needs no database.
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `feat(service): update.latest reads the newest release from GitHub`.

### Task 4: The apply script (install, wait for start, roll back)

**Files:**
- Create: `packages/service/src/update/apply-script.ts`, `packages/service/test/update/apply-script.test.ts`.

**Interfaces:**
- Produces:
  - `APPLY_SCRIPT: string` (POSIX sh);
  - `applyArgs({installSh, version, from, installBase, updateDir, timeoutS = 90}): string[]`.
- The script:
  1. Runs `SUDO="sudo -n" THREADGARDEN_SKIPPED_FILE="$updateDir/skipped" sh "$installSh"`, with its output to `$updateDir/install.log`.
  2. If install.sh exits non-zero: `ln -sfn "$installBase/$from" "$installBase/current"`, `systemctl --user restart threadgarden`, and writes `last.json` `{"state":"failed","version":…,"from":…,"reason":"install"}`.
  3. Otherwise it polls up to `timeoutS` for `last.json` with state `done` and the same version (written by the new service's `reconcile()`).
  4. On timeout it rolls back the same way and writes reason `start`.
  5. It removes `pending.json` on failure, so the restored service doesn't mark itself done.
  6. It uses `SYSTEMCTL=${SYSTEMCTL-systemctl}` as a test seam.

- [ ] **Step 1: Failing tests** (real `sh`, skipped on win32 or as root, stubs as in `install.test.ts`), each with a fake installBase holding `0.7.0/` and `0.7.1/` and a stub `install.sh`:
  - `install success and a done last.json within the timeout leaves current at the new version`;
  - `install exit 1 points current back at 0.7.0, restarts, and writes failed/install`;
  - `no done within the timeout (timeoutS=2) rolls back and writes failed/start`;
  - `the written last.json parses with UpdateStatusSchema`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Write the JSON with `printf` of the fixed fields; versions are already validated.
- [ ] **Step 4: Run.** PASS on Linux.
- [ ] **Step 5: Commit** `feat(service): the update's apply step rolls back when the new version doesn't start`.

### Task 5: The machine updater (download, check, launch, status)

**Files:**
- Create: `packages/service/src/update/updater.ts`, `packages/service/test/update/updater.test.ts`.
- Modify: `server/handlers/update.ts`, `main.ts`, `packages/service/test/server/local-only.test.ts` (convert the Task 1 todos).

**Interfaces:**
- Consumes: Task 1 schemas; Task 3 `fetchChecked`; Task 4's `APPLY_SCRIPT` and `applyArgs`.
- Produces:
  - `class MachineUpdater` with constructor deps:
    - `dataDir`, `currentVersion` (pkg.version);
    - `installBase` (default `~/.local/share/threadgarden-headless`);
    - `fetch`;
    - `run: (cmd, args) => Promise<{code, stdout, stderr}>` (execFile seam, used for `tar` and `systemd-run`);
    - `busyCount: () => Promise<number>`;
    - `emit: (s: UpdateStatus) => void`;
    - `now`.
  - Methods:
    - `supported(): boolean`: Linux, and `installBase/current` exists.
    - `status(): UpdateStatus`.
    - `start(version, force): Promise<UpdateStartResult>`.
    - `reconcile(): Promise<void>`, run at startup.
  - Files under `<dataDir>/update/`:
    - `pending.json`: `{version, from}`, written just before launch;
    - `skipped`: lines written by install.sh;
    - `last.json`: the final `UpdateStatus`, `done` or `failed`;
    - `<version>/`: the download, deleted on failure and by `reconcile()`.
  - Handlers:
    - `update.start` throws `NOT_SUPPORTED`, `INVALID_VERSION`, `ALREADY_CURRENT` (the version equals current) or `UPDATE_RUNNING`.
    - `update.status` is open to paired devices.
  - In `main.ts`:
    - the `update` capability is added to `capabilities` when `headless && updater.supported()`;
    - `busyCount` counts sessions where `busyOf(...)` is non-null (reuse `busyOf` from `handlers/move.ts`), plus external sessions with `status==='busy'||state==='working'`;
    - `emit` broadcasts `update.progress`.

- [ ] **Step 1: Failing tests**, with a tmp dataDir, a fake fetch serving a real small tarball built in the test (a `threadgarden-headless-0.7.1/VERSION` file, packed with `tar` via `run`, skipped on win32) and its sha256 line, and a fake `run` that records the `systemd-run` call:
  - `start with busy chats and force=false returns {started:false, busy:2} and changes nothing`;
  - `start downloads, checks the sha256, unpacks, writes pending.json, then launches systemd-run --user with the apply script`. The emitted stages are, in order: `downloading`, `installing`, `restarting`.
  - `a checksum mismatch fails with checksum and removes the download`;
  - `a VERSION file that differs fails with unpack`;
  - `a failed download leaves nothing behind and reports download`;
  - `a second start while running is refused with UPDATE_RUNNING`;
  - `start for the current version is ALREADY_CURRENT; ../x is INVALID_VERSION`;
  - `reconcile with pending.json for this version writes last.json done with the skipped lines and cleans up`;
  - `reconcile leaves a last.json failed written by the apply script as the status`;
  - `status is idle with no files, running while started, then last.json`;
  - `the update capability is offered only when supported`. This one is a `startService` test with a fake installBase.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** The launch is:

  ```
  run('systemd-run', ['--user', '--collect', `--unit=threadgarden-update-${version}`, '/bin/sh', applyPath, ...applyArgs(...)])
  ```

  `applyPath` is the apply script, written from `APPLY_SCRIPT` into `<dataDir>/update/apply.sh` by this (old) version.

  `install.sh` runs from the unpacked `threadgarden-headless-<version>/`. Status `running` lasts until the service exits. `reconcile()` is called in `main.ts` before the remote listener starts.
- [ ] **Step 4: Run** the service suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): a headless machine updates itself to a given release`.

### Task 6: The mock service simulates updates

**Files:** Modify `packages/service/src/testing/mock-main.ts` and `packages/service/test/testing/mock-main.test.ts` (or the nearest existing mock test).

**Interfaces:**
- Produces:
  - The main mock's `update.latest` answers `THREADGARDEN_MOCK_LATEST` (default `'0.99.0'`).
  - The `--remote` mock offers `update` and simulates `update.start`:
    - stages every ~300 ms;
    - then a pretend restart: drop device sockets, report `serviceVersion` as the new version in later `hello`s, and `update.status` `done`.
  - Mock-only local hooks: `mock.failNextUpdate {reason: UpdateFailure}` and `mock.setBusy {count}`, in the style of `mock.forgetMoves`.
  - It uses the `StartOptions.update` seam (a fake `MachineUpdater`-shaped object), never the real systemd path.

- [ ] **Step 1: Failing test:** `the remote mock updates to 0.99.0 and reports it in hello after the pretend restart`; `failNextUpdate(checksum) makes the next update fail with checksum`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** The hello `serviceVersion` override needs a seam in `main.ts` (`StartOptions.serviceVersion?: () => string`, default `pkg.version`).
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `test(service): the mock machine simulates an update`.

### Task 7: The desktop knows every machine's version

**Files:**
- Modify `apps/desktop/src/lib/service/client.ts` and `apps/desktop/src/lib/state/machines.svelte.ts`.
- Tests: `apps/desktop/tests/service/client.test.ts`, `apps/desktop/tests/state/machines.test.ts`.

**Interfaces:**
- Produces:
  - `ServiceClient.lastHello: HelloResult | null`: set for every answered hello, including one rejected as incompatible. `hello` keeps its meaning.
  - `MachineEntry.version: string | null`: the last seen `serviceVersion`, remembered across restarts in uiState key `machines.versions` (`Record<machineId, string>`), loaded in `init`.
  - `MachineEntry.canUpdate: boolean`: the last hello's `machine.capabilities` includes `'update'`.
  - `MachinesState.openForUpdate(id): Promise<ServiceClient>`: a separate client to that machine with `acceptProtocol: () => true`, closed by the caller. It's used only for `update.*`.

- [ ] **Step 1: Failing tests:**
  - `an incompatible hello still records version and updatability` (fake ws answering protocol 12 with capabilities `['update']`): the status is `incompatible`, `version` is `'0.9.0'`, and `canUpdate` is true;
  - `a machine's version survives a desktop restart via machines.versions`;
  - `openForUpdate connects despite an out-of-range protocol`.
- [ ] **Step 2: Run** `… --filter desktop exec vitest run tests/service/client.test.ts tests/state/machines.test.ts`. FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** PASS.
- [ ] **Step 5: Commit** `feat(desktop): remember each machine's Threadgarden version`.

### Task 8: MachineUpdatesState (latest, behind, the update flow)

**Files:**
- Create: `apps/desktop/src/lib/state/bring-up.ts`, `apps/desktop/src/lib/state/machine-updates.svelte.ts`, `apps/desktop/tests/state/machine-updates.test.ts`.
- Modify: `apps/desktop/src/lib/move/move-chat.svelte.ts` (import `bringUp` and `waitUntilOn` from `bring-up.ts`; behaviour unchanged, move tests stay green), `state/app.ts` and `state/context.ts` (wire a singleton `machineUpdates` into `useApp()`).

**Interfaces:**
- Consumes: Task 7 (`version`, `canUpdate`, `openForUpdate`); `power.turnOn/config/error`; `machines.shown`; `updates.available`; `compareVersions` from `connection.svelte.ts`.
- Produces:
  - `bringUp(app: {machines, power}, id, opts: {waitMs, alive?}): Promise<void>`: moved verbatim, error texts unchanged. `waitUntilOn` is exported from the same file.
  - `class MachineUpdatesState`:
    - `latest: string | null`;
    - `behind(m): boolean`: `m.version && latest && compareVersions(m.version, latest) < 0 && m.canUpdate`;
    - `anyBehind: boolean`;
    - `tooOld(m): boolean`: the version is known and `!m.canUpdate`;
    - `stage(id): 'turningOn'|UpdateStage|null`;
    - `outcome(id): UpdateStatus | null` (done or failed);
    - `refresh({force?})`;
    - `prepare(id): Promise<{busy: number} | null>`, meaning ask first or go;
    - `update(id, force): Promise<void>`;
    - `init(deps: {api, now?})`.
  - Latest checks run at +10 s, then every 6 h, plus on Settings open if older than 10 min. A failure keeps the old `latest` and shows nothing.
  - The flow:
    1. bring up if Off (stage `turningOn`);
    2. `update.start {version: latest, force}` through `m.client` when status is on, else through `openForUpdate`;
    3. `{started:false, busy}` goes back to the UI for the prompt;
    4. follow `update.progress`;
    5. after the drop, wait for reconnect (`RECONNECT_WAIT_MS` from move-chat, 2 min, plus the 90 s start timeout) and read `update.status`.
  - `UPDATE_RUNNING` follows the running status instead of failing.

- [ ] **Step 1: Failing tests** (fake api, fake machines and power, fake timers):
  - `behind needs a known version, a known latest, an older version and canUpdate`;
  - `an unreachable latest check shows nothing and retries on schedule`;
  - `prepare returns busy count from update.start force=false`;
  - `an Off machine with power is turned on first; without power update is not offered`;
  - `follows downloading → installing → restarting, then reads done after reconnect`;
  - `restores a finished update's outcome after a desktop restart` (status read on init and on reconnect);
  - `UPDATE_RUNNING follows the running update`;
  - `updates an incompatible machine through an update-only client`;
  - `move-chat still brings up an Off target` (existing move tests pass unchanged).
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full desktop suite. PASS.
- [ ] **Step 5: Commit** `feat(desktop): update a machine to the latest release`.

### Task 9: Settings UI and the dot

**Files:**
- Create: `apps/desktop/src/lib/components/MachineUpdate.svelte`, `apps/desktop/tests/settings/machine-update.test.ts`.
- Modify: `MachinesSettings.svelte` (This PC line; per card, the version next to the state row and `<MachineUpdate machine={m} />` by the buttons), `layout/PlacesColumn.svelte:250`, `layout/AppShell.svelte:117`.

**Interfaces:** Consumes Task 8. Every string is from Global Constraints.

The dot is a small `span` inside the `IconButton` children, with `aria-hidden`. The button's `label` becomes `Settings (a machine update is available)` while `anyBehind`; it stays a substring of "Settings", which the e2e relies on.

- [ ] **Step 1: Failing component tests:**
  - `shows This PC · Threadgarden <appVersion> and the machine's version`;
  - `Update to 0.7.1 appears only when behind`;
  - `busy asks first with the count and Update anyway; This PC's own update adds its line`;
  - `stages show in order, then Threadgarden 0.7.1 ✓`;
  - `each failure reason shows its line`;
  - `a skipped polkit or linger step shows its note`;
  - `off without power control: disabled with Turn it on to update`;
  - `too old: Update it over SSH this once links the guide`;
  - `the dot shows on both Settings buttons only while a machine is behind`.
- [ ] **Step 2: Run.** FAIL.
- [ ] **Step 3: Implement.** Use the existing `ConfirmDialog` for the prompt. Opening Settings calls `machineUpdates.refresh()`.
- [ ] **Step 4: Run** the desktop suite, typecheck and lint. PASS.
- [ ] **Step 5: Commit** `feat(desktop): versions and Update in Settings, a dot when a machine is behind`.

### Task 10: E2E and docs

**Files:**
- Create: `apps/desktop/e2e/update.spec.ts`.
- Modify: `apps/desktop/e2e/playwright.config.ts` (the `THREADGARDEN_MOCK_LATEST` env if needed), `docs/remote-machines.md` (`## Upgrading`, the troubleshooting row "Different Threadgarden version"), `docs/architecture.md` (versions 9–11 / local 10; an Update paragraph under Machines), `CONTRIBUTING.md` (if it lists methods).

- [ ] **Step 1: Write the spec**, pairing as `move.spec.ts` does:
  - `Settings shows Ubuntu's version, the dot, and Update to 0.99.0`;
  - `busy asks first` (`mock.setBusy {count:1}`);
  - `updating shows the stages and ends with Threadgarden 0.99.0 ✓ and no dot`;
  - `a checksum failure shows its line` (`mock.failNextUpdate`).
- [ ] **Step 2: Run** `pnpm --config.verify-deps-before-run=false test:e2e`. FAIL before the docs, PASS after the earlier tasks (the spec only needs Tasks 6–9).
- [ ] **Step 3: Docs.**
  - **Upgrading** leads with "Settings → Machines → Update to X". It covers:
    - what happens (download, checksum, install, rollback within 90 s);
    - the skipped-step notes;
    - the manual way, kept for machines older than 0.8.0 (the release that brings this) and for a failed update;
    - where the log is (`~/.local/share/threadgarden/update/install.log`, `logs/service.log`).
- [ ] **Step 4: Run** the full suite: `pnpm --config.verify-deps-before-run=false test`, `typecheck`, `lint`, e2e. PASS.
- [ ] **Step 5: Commit** `docs: updating a machine from Settings` (and the e2e: `test(e2e): updating a machine`).

## After the build (owner, by hand)

1. Release the version that carries this (minor: **0.8.0**). Update kumbal **over SSH this one last time**.
2. On the next release, test from Settings:
   - the dot, `Update to …`;
   - with a chat mid-turn: the prompt;
   - with kumbal Off: it starts, then updates;
   - the result: `Threadgarden … ✓` and kumbal works.
