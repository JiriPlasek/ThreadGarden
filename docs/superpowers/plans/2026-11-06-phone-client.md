# Threadgarden on the phone, stage one: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android app that shows all the owner's machines, including the main PC, with the same chats as the desktop, Turn on through the plug, and an immediate alert with the app closed. It never runs Claude Code.

**Architecture:**
- **The same Svelte UI in Tauri's Android webview,** still talking only to loopback.
- **A Rust core** (`threadgarden-core`, a plain crate tested on any host) takes the local service's place: loopback WebSocket, local methods, pairing, pinned relay, plug control, alert links.
- **A Kotlin foreground service** holds the permanent notification and keeps the core alive without the screens.
- **The main PC** gets a local-only, off-by-default listener, the same one a headless machine has.
- **Machines don't change.** The phone speaks what they already speak.

**Tech Stack:** Tauri 2 (Android), Rust (tokio, tokio-tungstenite with rustls), Kotlin, Android Keystore, SvelteKit 5 runes, Node 22 service, zod, Vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-05-phone-client-design.md`

**Gate:** Task 1 is a throwaway spike tested on the owner's phone. **Nothing else starts until the owner has seen it work.** If Android can't keep the connection alive there, the design goes back to the owner.

## Global Constraints

- **No cloud:** no push service, relay server or account. No Firebase or Google Play Services dependency.
- **The phone never runs Claude Code,** and the app contains no Node.
- **The desktop is unchanged unless the owner turns on Let my phone connect.** Its suites stay green, and a desktop build contains no Android-only behaviour.
- **Phone or desktop is decided by platform, never by window width:** `native.isPhone` (from `TAURI_ENV_PLATFORM`, or `VITE_THREADGARDEN_PHONE=1` for the mock). A narrow desktop window stays the desktop layout.
- **No protocol bump in this plan:** `PROTOCOL_VERSION` stays 11, and new methods are local-only. The phone accepts machines with `acceptsRemoteProtocol`'s rule, re-stated in Rust and pinned by a test (Task 3).
- **The webview's CSP is unchanged:** `connect-src` the Tauri IPC origins and `ws://127.0.0.1:*`. The Android network security config allows cleartext to `127.0.0.1` only.
- **The core binds to `127.0.0.1` only,** on a random port, with a random bearer token per process.
- **Pairing order:** the machine's HMAC proof is checked against the certificate seen **before** the code is sent, as in `machine/pairing-client.ts`. A machine failing the proof never sees the code.
- **Secrets** (device tokens, bridge passwords) are stored only in a file encrypted with an Android Keystore key, never logged, and never sent anywhere except the machine or bridge they belong to. Android backup excludes that file (`allowBackup="false"`).
- **Never send** `ui.visibility` or `power.adopt` from the phone. Both would change state for the machine's other clients.
- **Never offer** `bypassPermissions`, matching the desktop.
- **Foreground service:** type `specialUse`, with `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` stating the reason. `minSdk` 26, `targetSdk` as Tauri's template, permissions `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `ACCESS_NETWORK_STATE`. No others.
- **Back-off:** an alert link retries from 2 s doubling to 60 s. A network change resets it. Ping every 15 s, and a missed pong by the next ping means dead, as in `server/relay.ts`.
- **Copy:**
  - setting `Let my phone connect`; its help `Your phone can use this PC's chats, on your private network. Windows may ask to allow it. After a restart, this PC is reachable once someone signs in.`;
  - pairing button `Show a pairing code`;
  - notification title `Connected to your machines`, action `Disconnect`;
  - alerts `‹machine›: ‹chat› needs you` and `‹machine›: ‹chat› finished`;
  - plug form title `Plug for ‹machine›`, Turn on hint `Enter this machine's plug details to turn it on from here`;
  - update notice `Threadgarden ‹version› is available`, button `Download`.
- **Test text is made-up,** never real names, addresses or chats. Screenshots come from the mock only.
- **Repo conventions:** `pnpm --config.verify-deps-before-run=false`; no Claude attribution in commits; plain separate git commands. The Android signing key is created by the owner and never handled by an agent.

## Review Focus

1. **The webview is destroyed, or the app is swiped away, while the core lives on.** Reopening reconnects to the same core, with no second core, no lost pairing and no doubled alerts. Test: Task 1 (on the phone), Task 10 `start twice returns the same core`.
2. **Wi-Fi to mobile data with Tailscale coming up late.** Links recover by themselves within a minute, without the owner touching anything, and alerts missed meanwhile show as unread rather than a burst. Test: Task 9 `a reconnect catches up without alerting past chats`.
3. **A machine answers at the address with another certificate.** It's refused before the token is sent, and the phone says so as the desktop does (4409). Test: Task 7 `a different certificate gets no token`.
4. **The main PC's setting is off, or turned off with the phone connected.** Nothing listens when off; turning it off disconnects at once; a paired phone can't turn it on or off. Test: Task 3 `no listener by default`, `turning it off closes the sockets`, `a device can't change it`.
5. **A plug that's already drawing power.** Turn on doesn't cut a running machine, and honours the minimum off time, as the hub does. Test: Task 8 `a machine drawing power is not cycled`, `the minimum off time holds`.

---

### Task 1: The spike (owner gate)

Throwaway branch `spike/phone`, never merged. Results go in `docs/superpowers/specs/2026-11-06-phone-spike-results.md`, committed on the plan's branch.

**Files:** on the spike branch, `tauri android init` output, a minimal Kotlin foreground service, a Rust loop, and a manual `android-spike.yml` workflow that builds a debug APK as an artifact.

- [ ] **Step 1:** Prove the build: a workflow on ubuntu with the Android SDK and NDK builds the app with desktop-only crates excluded and uploads the APK.
- [ ] **Step 2:** Prove loopback: the webview opens `ws://127.0.0.1:<port>` to the Rust side under the real CSP.
- [ ] **Step 3:** Prove TLS: from Rust, `wss://` to kumbal with the certificate compared against a pin (rustls; no OpenSSL). Use kumbal's existing listener with a pinned certificate set in the spike's build input, and connect only as far as the protocol's refusal or a real device token the owner pairs in the spike. Nothing secret is committed.
- [ ] **Step 4:** Prove lifetime: the foreground service starts the Rust core through a JNI entry, independently of the Tauri activity. The core must survive swiping the app away, and reopening must find the same one. Decide where the runtime lives (a process-wide `OnceLock`).
- [ ] **Step 5:** Prove an alert: with the app closed and the screen off, a chat on kumbal needing the owner posts a notification.
- [ ] **Step 6: The owner's checks on their phone** (install from the artifact):
  1. the notification and the connection last an hour with the screen off;
  2. an alert arrives within seconds, on Wi-Fi and on mobile data over Tailscale;
  3. swipe the app away and repeat 2;
  4. reboot and see it return;
  5. note the phone's maker, Android version, and battery use for a day;
  6. the bridge's address answers over Tailscale from mobile data.
- [ ] **Step 7:** Write the results, including anything that overturns this plan. **Stop for the owner's decision.**

### Task 2: One app, two platforms

**Files:** `apps/desktop/src-tauri/Cargo.toml`, `src/lib.rs`, `src/main.rs`, new `gen/android/` (committed, without build output), `tauri.android.conf.json`, `capabilities/mobile.json`, `apps/desktop/package.json`, `.github/workflows/ci.yml`, `scripts/set-version.mjs`.

**Interfaces:** Produces `#[cfg(desktop)]` around tray, autostart, single-instance, updater, `keyring`, `discovery`, `service` and `dropped`; `#[cfg_attr(mobile, tauri::mobile_entry_point)]` on `run`; `pnpm android:build`. The application id is `dev.threadgarden.phone`, so it never collides with the desktop's identity.

- [ ] **Step 1:** Failing test: `versions.test.ts` expects the Android version name to match; run it.
- [ ] **Step 2:** Gate the desktop-only crates and modules under `cfg(desktop)`; add the Android project and an empty mobile capability.
- [ ] **Step 3:** `set-version.mjs` writes the Android version. Run the versions test: PASS.
- [ ] **Step 4:** CI gets an `android` job (ubuntu, SDK and NDK cached) that builds a debug APK. Existing jobs are unchanged.
- [ ] **Step 5:** Confirm desktop `cargo test`, and that `tauri.conf.json`'s `identifier` and CSP are untouched.
- [ ] **Step 6: Commit** `feat(android): build the app for Android beside the desktop`.

### Task 3: The main PC can listen

**Files:** `packages/protocol/src/machines.ts`, `methods.ts`; `packages/service/src/main.ts`, `server/handlers/machines.ts`, `history/migrations.ts`; tests `test/server/phone-access.test.ts`, `test/server/local-only.test.ts`, `packages/protocol/test`; a new Rust-readable fixture `packages/protocol/test/fixtures/protocol-range.json`.

**Interfaces:** Produces local-only `phoneAccess.get` → `{enabled: boolean, addresses: string[], port: number}` and `phoneAccess.set {enabled: boolean}`, an event `phoneAccess.changed`, and for a desktop with it on, `pairing.create`, `devices.list` and `devices.revoke` as on a headless machine. The value lives in its own table row, **not in `settings`**, because `settings.set` can be called by paired devices.

- [ ] **Step 1: Failing tests:**
  - `no listener by default`;
  - `turning it on listens on private addresses, with the headless port`;
  - `turning it off closes the sockets`;
  - `a device can't change it` (`FORBIDDEN`);
  - `a desktop that's listening never exits when idle`;
  - `off again, the idle exit is back`;
  - `the certificate survives off and on, so the pairing holds`;
  - `the choice survives a restart`;
  - `a paired device can't call power.shutdown on a desktop`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Split `listen` creation from `headless`: the TLS identity is created the first time it's turned on, and `moveRemote` runs when `headless || phoneAccess`. `pair.proof` works whenever the identity exists. The desktop's `machineOf` capabilities are unchanged. Headless behaviour stays byte-for-byte.
- [ ] **Step 4:** Run, plus `test/main.test.ts`. PASS.
- [ ] **Step 5: Commit** `feat(service): a desktop can listen for a paired phone, when asked`.

### Task 4: Let my phone connect

**Files:** `apps/desktop/src/lib/components/MachinesSettings.svelte`, a new `PhoneAccess.svelte`, `state/machines.svelte.ts`; tests `tests/settings/phone-access.test.ts`.

**Interfaces:** Consumes Task 3. Uses the existing autostart command for "start at sign-in".

- [ ] **Step 1: Failing tests:**
  - `off by default, with the help text`;
  - `on shows its addresses and Show a pairing code`;
  - `a code shows as XXXX-XXXX-XXXX and expires`;
  - `paired devices list, and Remove revokes one`;
  - `on offers to start at sign-in, and doesn't turn it on by itself`;
  - `off says the phone disconnects, and asks first when a phone is connected`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement, with the exact copy.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `feat(desktop): Let my phone connect`.

### Task 5: The core: loopback, local answers, storage

**Files:** new crate `apps/desktop/src-tauri/core/` (`Cargo.toml`, `src/lib.rs`, `server.rs`, `methods.rs`, `store.rs`, `secrets.rs`), with a `[workspace]` added to `src-tauri/Cargo.toml` (it has none today); `packages/protocol/test/core-contract.test.ts`.

**Interfaces:**
- Produces `Core::start(CoreConfig { data_dir, secrets: Arc<dyn Secrets>, machine_name }) -> CoreHandle`, `CoreHandle::{port(), token(), events(), stop()}`, and a `Secrets` trait `{ get(key), set(key, value), delete(key) }`, with an in-memory version for tests.
- `store.rs` owns a JSON or SQLite file (the implementer's choice, stated in the report) for machines and settings, built so stage two can add copies and a queue.
- Consumes the frame shape from `packages/protocol`, and `MAX_REQUEST_BYTES`.

- [ ] **Step 1:** List what the UI calls on its local client: from `state/app.ts` `wire()`, `scope.ts` and the stores. Put the list in the report. Every one gets an answer or a deliberate `METHOD_NOT_FOUND` the UI tolerates.
- [ ] **Step 2: Failing tests:**
  - `refuses a socket without the token`;
  - `binds only 127.0.0.1`;
  - `hello says protocol 11 and an empty, non-headless machine`;
  - `the chat lists answer empty`;
  - `settings and uiState round-trip across a restart`;
  - `an unknown method gets METHOD_NOT_FOUND`;
  - `an oversized frame is refused`.
- [ ] **Step 3:** The contract: a test binary writes each answer to JSON, and `core-contract.test.ts` parses them all with the zod result schemas. A core answer that drifts from the protocol fails in CI.
- [ ] **Step 4:** Implement. Run `cargo test -p threadgarden-core` and the contract test. PASS.
- [ ] **Step 5: Commit** `feat(core): the phone's stand-in for the local service`.

### Task 6: The core: pairing

**Files:** `core/src/pairing.rs`, `core/src/machines.rs`; tests in `core/tests/pairing.rs` with a small real TLS test listener in `core/tests/support/`.

**Interfaces:** Consumes `machine/pairing-client.ts` and `server/remote-server.ts` as the reference for subprotocols, `pair.proof`, `pair.claim`, the HMAC input and the pinned form. Produces `machines.pair`, `machines.list`, `machines.update`, `machines.remove`, `machines.unlock`, the same shapes as the service. `machines.unlock` is accepted and harmless, since the core reads tokens itself.

- [ ] **Step 1: Failing tests:**
  - `a good machine pairs and its token is stored as a secret`;
  - `a machine failing the proof never gets the code`;
  - `a relayed proof under another certificate fails`;
  - `the wrong code says so`;
  - `an already paired machine is refused before the code goes`;
  - `removing forgets the token first, then revokes if reachable`;
  - `tokens never reach the store file or a log`.
- [ ] **Step 2:** A cross-check: pair the core against a real headless service in a Node test (`packages/service/test/core-pairing.test.ts`), so the two implementations can't drift. Skip it where no Rust binary was built, and run it in CI.
- [ ] **Step 3:** Implement. Run. PASS.
- [ ] **Step 4: Commit** `feat(core): pair with a machine, proof before code`.

### Task 7: The core: the relay

**Files:** `core/src/relay.rs`; `core/tests/relay.rs`.

**Interfaces:** Produces `/relay?machine=<id>`, with the close codes of `server/relay.ts`: 4404, 4409, 4403, 4502.

- [ ] **Step 1: Failing tests:**
  - `frames pass through verbatim, both ways` (text and binary);
  - `a different certificate gets no token` (4409);
  - `a revoked device closes 4403`;
  - `no token here closes 4404`;
  - `frames sent before the link is up wait 10 s, then 4502`;
  - `a dead link is noticed within two pings`;
  - `moving a machine closes its relays 4502`;
  - `a certificate date error reads as unreachable, not another machine`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement. It never parses, logs or rewrites frames.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `feat(core): a pinned relay to each machine`.

### Task 8: The core: the plug

**Files:** `core/src/power.rs`; `core/tests/power.rs`, with a small fake Tasmota; `apps/desktop/src/lib/state/power.svelte.ts`.

**Interfaces:** Consumes the commands in `power/switch.ts` and the rules in `power/hub.ts`. Produces the `power.*` methods the UI's plug state needs, for Turn on and readings. Settings per machine come from the owner's typed plug details; the password goes to `Secrets`. There's no rule installing and no `power.adopt`. Shutdown stays the machine's own `power.shutdown`, offered only for machines with the `power` capability.

- [ ] **Step 1: Failing tests:**
  - `Turn on sends the plug's on`;
  - `a machine drawing power is not cycled`;
  - `the minimum off time holds`;
  - `a plug reading on but below offWatts is cycled, as on the desktop`;
  - `one operation at a time per machine`;
  - `a wrong password says so and is not retried in a loop`;
  - `an unreachable bridge says so`;
  - `no polling without a screen open`;
  - `the password never reaches the store file or a log`;
  - UI: `a machine without plug details shows the hint`, `the main PC without details has no Turn on`, `a phone never offers a hard cut`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `feat(core): turn a machine on through its plug`.

### Task 9: The core: alert links

**Files:** `core/src/alerts.rs`; `core/tests/alerts.rs`.

**Interfaces:** Produces `CoreHandle::events()` with `Alert { machine_id, machine_name, session_id, chat_title, kind: NeedsYou | Finished }`, and `alerts.setActive {machineId, sessionId} | null`. Consumes the machine's `needsYou` and `chatFinished` events and `sessions.list` with `needsYou`, as `apps/desktop/src/lib/notifications.ts` does.

- [ ] **Step 1: Failing tests:**
  - `an event alerts once`;
  - `the chat on screen doesn't alert`;
  - `a reconnect catches up without alerting past chats`;
  - `streamed output is dropped without being stored`;
  - `back-off grows to 60 s, and a network change resets it`;
  - `a link never sends ui.visibility`;
  - `a removed machine's link closes`;
  - `Disconnect closes every link and stays closed`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement, respecting the same notification settings as the desktop where they apply.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `feat(core): know when a machine needs you, without the screens`.

### Task 10: The Android service

**Files:** `gen/android/.../CoreService.kt`, `BootReceiver.kt`, `KeystoreSecrets.kt`, `AndroidManifest.xml`, `res/xml/network_security_config.xml`; `apps/desktop/src-tauri/src/android.rs` (JNI); `native.ts`.

**Interfaces:** Consumes Tasks 5–9 and what Task 1 proved. Produces Tauri commands `service_connection` (the core's port and token), `alerts_set_active`, `keep_alive_status`, `request_battery_exemption`, and `disconnect`. Exact shape per the spike's results.

- [ ] **Step 1: Failing tests** (host-testable part, in `android.rs` behind a seam): `start twice returns the same core`, `after Disconnect a boot doesn't start it`, `a boot starts it if it was connected`.
- [ ] **Step 2:** Implement: the service holds the notification (exact copy) and posts alerts; tapping one opens that chat; a Disconnect action; `ConnectivityManager` network changes call the core; the first run explains and asks for notifications and the battery exemption.
- [ ] **Step 3:** Keystore-backed `Secrets`, with `allowBackup="false"`. A Keystore key that's gone (a restored phone) means pair again, not a crash.
- [ ] **Step 4:** Run the tests and the debug APK build in CI. Unit tests can't prove the Android parts: the owner's test covers those.
- [ ] **Step 5: Commit** `feat(android): keep the core running and alert from a foreground service`.

### Task 11: The UI without This PC

**Files:** `apps/desktop/src/lib/native.ts`, `state/app.ts`, `state/machines.svelte.ts`, `state/scope.ts`, `components/layout/PlacesColumn.svelte`, `NewChatDialog.svelte`, `notifications.ts`, `SettingsDialog.svelte`, `MachinesSettings.svelte`; `packages/service/src/testing/mock-main.ts`; tests `tests/phone/*.test.ts`.

**Interfaces:** Consumes `native.isPhone`. The local scope stays, answered with empties by the core. `copySync`, `away` and `copies` aren't wired on the phone in stage one (`deps.copies` is already optional). Produces a mock mode `MOCK_PHONE=1`, a main service answering like the core, with remote machines, for e2e.

- [ ] **Step 1: Failing tests:**
  - `the places column has no This PC group`;
  - `New chat never offers This PC, and defaults to the last machine used`;
  - `with no machines, it offers Add machine and nothing else`;
  - `Add machine asks for an address and a code`;
  - `analytics, tray, autostart and desktop update are absent`;
  - `the webview posts no alerts`;
  - `the open chat is told to the core`;
  - `a desktop build's places column still has This PC`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement, gating on `isPhone`, and keep the changes to shared code small.
- [ ] **Step 4:** Run the whole desktop suite. PASS.
- [ ] **Step 5: Commit** `feat(phone): the app without a local machine`.

### Task 12: The phone layout

**Files:** a new `components/phone/PhoneShell.svelte`, `PhoneNav.svelte`, `RecentChats.svelte`; `AppShell.svelte` picks the shell; `ChatView.svelte`, `Composer.svelte` and dialogs where touch needs it; `apps/desktop/e2e/phone.spec.ts`, `playwright.config.ts` (a project at a phone viewport with `MOCK_PHONE=1`).

**Interfaces:** Consumes the existing stores unchanged. Produces one-column navigation: machines and places → chat list → chat, with the Android back gesture moving up one level before leaving the app.

- [ ] **Step 1: Failing e2e tests:**
  - `a chat opens from a machine, and back returns to its list`;
  - `a reply goes to that machine`;
  - `a question from Claude can be answered by touch`;
  - `Needs you and Running list across machines`;
  - `search finds a chat on a machine`;
  - `a new chat starts on the chosen machine`;
  - `recent chats switch`;
  - `the keyboard doesn't cover the composer`;
  - `targets are at least 44 px`;
  - `an image can be attached through the picker`;
  - `Turn on works from the machine's menu`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement. Desktop components stay as they are unless touch requires otherwise, and then only behind `isPhone`.
- [ ] **Step 4:** Run the phone project and the full e2e suite. PASS.
- [ ] **Step 5: Commit** `feat(phone): one column at a time`.

### Task 13: Plug details, updates and settings on the phone

**Files:** new `components/phone/PlugDetails.svelte`, `PhoneUpdateNotice.svelte`; `core/src/update.rs`; `SettingsDialog.svelte`; tests.

**Interfaces:** Consumes Task 8. The update check asks GitHub's latest release from the core, since the CSP blocks it in the webview, and `opener` opens the APK's URL. It never downloads or installs by itself.

- [ ] **Step 1: Failing tests:**
  - `plug details save, and the password isn't shown again`;
  - `a wrong password is reported on save`;
  - `an older app shows the notice, and Download opens the release's APK`;
  - `the same version shows nothing, and a failed check says nothing`;
  - `Settings shows Disconnect, the battery exemption's state, and this app's version`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. PASS.
- [ ] **Step 5: Commit** `feat(phone): plug details, update notice and its settings`.

### Task 14: The release

**Files:** `.github/workflows/release.yml`, `docs/releasing.md`, `packages/service/test/packaging` (a workflow test if one fits).

**Interfaces:** Secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. **The owner creates and adds these,** following `docs/releasing.md`. Produces the asset `threadgarden-<version>.apk`, in `SHA256SUMS`.

- [ ] **Step 1:** An `android` release job signs the APK and uploads it to the draft, before publish. A missing secret fails the job with a clear message, keeping the release a draft.
- [ ] **Step 2:** Rehearse with `dry_run` once the owner has added the secrets.
- [ ] **Step 3: Commit** `feat(release): a signed Android APK with every release`.

### Task 15: Docs

**Files:** new `docs/phone.md`, `docs/architecture.md`, `docs/remote-machines.md`, `README.md` (one feature line and the limitation), `docs/releasing.md`.

- [ ] **Step 1:** `docs/phone.md`: install, Tailscale, pairing, plug details, the battery exemption and what makers' settings can do, Disconnect. **What a lost phone can do, and how to remove it from every machine.** What a paired phone can do on the main PC, including `settings.set` and `work.stopAll`.
- [ ] **Step 2:** `docs/architecture.md`: the core, the alert links, the main PC's listener; correct "the listener is headless only".
- [ ] **Step 3:** `prettier --check` the touched files.
- [ ] **Step 4: Commit** `docs: Threadgarden on the phone`.

## After the build (owner)

1. Create the signing key and add the four secrets (`docs/releasing.md`).
2. Release, install the APK, and turn on **Let my phone connect** on the main PC.
3. Pair kumbal and the main PC. Chat on Wi-Fi and on mobile data.
4. With the app closed and the screen off for an hour, have Claude ask a question.
5. Reboot the phone. Turn kumbal on from mobile data.
6. Watch a day's battery use, and check kumbal still shuts down when idle.
