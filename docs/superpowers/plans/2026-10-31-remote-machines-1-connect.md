# Remote machines, plan 1 of 4: Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Threadgarden's service runs headless on a Linux machine, the desktop app pairs with it over the home LAN, and the owner sees, starts and runs chats on that machine from the desktop, laid out as machine groups in the places column.

**Architecture:** The service gains a machine identity, a device registry with one-time pairing codes, and an opt-in TLS listener on private LAN addresses (self-signed certificate, pinned by clients). The desktop UI never leaves loopback: it opens a second kind of WebSocket to its own local service at `/relay?machine=<id>`, and the local service pipes frames verbatim to the remote service over pinned TLS. In the UI, each machine gets its own set of the existing store classes (a *machine scope*); tabs and cross-machine views (Needs you, Running, buckets, agents strip, quick switcher, notifications) are keyed by machine id and merge across scopes.

**Tech Stack:** TypeScript (Node 22, `ws`, `node:sqlite`, `node:tls`, zod), `selfsigned` for the certificate, Tauri 2 / Rust (`keyring`), SvelteKit 5, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-remote-machines-design.md` (§5, §6, §7; parts of §3 and §12). Plans 2–4 cover §8–§10 and the rest of §7; see "Out of scope" below.

## Global Constraints

- Nothing goes through a cloud service; no vendor APIs, no relay outside the owner's machines (spec §3).
- The remote listener is **off by default**, binds only to private addresses (10/8, 172.16/12, 192.168/16, 100.64/10), **never** `0.0.0.0` or a public address (spec §6).
- Remote traffic uses TLS with a self-signed certificate pinned at pairing; loopback stays plain `ws://` (spec §6).
- The webview's CSP is unchanged: `connect-src ipc: http://ipc.localhost ws://127.0.0.1:*` (spec §6).
- Pairing codes are single-use and valid 5 minutes (spec §6). Device tokens are revocable from either side and never appear in URLs.
- Every paired device has full control (spec §6, designer's call).
- Hard rule from CONTRIBUTING.md: Threadgarden never writes, renames, moves or deletes anything under the Claude config dir. `test/e2e/read-only.test.ts` must keep passing.
- Threadgarden never offers `bypassPermissions`.
- `PROTOCOL_VERSION` becomes **5**. The desktop and its **local** service still require an exact match; a **remote** service is accepted when its protocol is 4, 5 or 6 (one version either way, spec §6), and methods it lacks fail with `METHOD_NOT_FOUND`, which the UI treats as "not supported on this machine".
- Node 22 (`engines >=22`, sidecar `v22.23.4`); the service bundle stays one esbuild file.
- Conventional commits; CI must pass on Windows, macOS and Linux.
- All app versions stay in sync (`apps/desktop/tests/versions.test.ts`); the headless package carries the same version.
- UI wording: the local machine is **This PC**; a machine heading's states in this plan are **On**, **Connecting…** and **Unreachable** (Off / Starting… / Shutting down arrive with power control in plan 4).

## Out of scope (later plans)

- Plan 2: clone and New project on a remote machine, worktrees, the push instruction, Move to…, This PC working-copy rules.
- Plan 3: local copies of an unreachable machine's lists and chats, updates from the desktop, combined analytics, the usage meter across machines.
- Plan 4: power control, idle shutdown, push check, the ⏻ menu, Off / Starting… / Shutting down, scheduled wake, messages queued while a machine is off, the bridge part of the setup guide.
- In this plan, Analytics and the usage meter keep showing This PC only; "Allow other devices" on a desktop install is not offered (only headless installs listen remotely).

## Review Focus

1. **The Ubuntu PC's address changes** (DHCP lease, `.local` name resolving to another host): a device at the old address must never receive the token; the machine shows Unreachable with the reason "this address answers as a different machine", and Settings → Machines lets the owner edit the address while keeping the pin. Test in Task 6 (pin mismatch → close 4409, token never sent) and Task 14 (edit address).
2. **The remote service or the Wi-Fi drops mid-turn**: the desktop reconnects through the relay with backoff and the chat resyncs through `chat.since` without duplicates or gaps; the remote chat keeps running meanwhile. Test in Task 9 (relay client reconnects after a 4502 close and replays `onReconnect`).
3. **The desktop app or its local service restarts while remote chats run**: the remote chats are unaffected, the relays re-open and the machines are unlocked again from the keychain without the owner doing anything. Test in Task 9 (unlock replayed on every local `onOpen`).
4. **The same session id or the same project path exists on two machines**: they stay separate everywhere (tabs, rows, Needs you, notifications). Test in Task 10 (two scopes, same session id, two tabs) and Task 11 (merged list keeps both rows).
5. **A pairing code typed wrong, expired or reused**: a clear error, no token; five wrong claims invalidate the code. Test in Task 2.

---

## File structure

**Protocol** (`packages/protocol/src/`)
- `version.ts` — `PROTOCOL_VERSION = 5`, `REMOTE_PROTOCOL_RANGE`, `acceptsRemoteProtocol()`.
- `machines.ts` *(new)* — `MachineInfoSchema`, `PairedMachineSchema`, `DeviceSchema`, capability names.
- `methods.ts` — `hello` result extended; new methods (Task 1, 2, 5, 6).

**Service** (`packages/service/src/`)
- `machine/identity.ts` *(new)* — machine id and name, persisted in `ui_state`.
- `machine/devices.ts` *(new)* — device registry, pairing codes, proofs, tokens.
- `machine/tls.ts` *(new)* — load or create the TLS identity.
- `machine/interfaces.ts` *(new)* — which local addresses may be listened on.
- `server/remote-server.ts` *(new)* — the TLS listener for devices and pairing.
- `server/relay.ts` *(new)* — the local `/relay` endpoint and the pinned link to a remote service.
- `machine/pairing-client.ts` *(new)* — the client side of pairing (proof check, claim).
- `machine/paired-machines.ts` *(new)* — the client's list of paired machines (`machines` table) and in-memory device tokens.
- `server/ws-server.ts` — path routing (`/` and `/relay`), `HandlerCtx.origin`.
- `server/router.ts` — `HandlerCtx` gains `origin`; local-only methods.
- `server/handlers/machines.ts` *(new)* — `machine.*`, `devices.*`, `pairing.create`, `pair.*`, `machines.*` handlers.
- `history/migrations.ts` — steps for `devices` and `machines`.
- `cli.ts` *(new)* — argument parsing and the CLI subcommands.
- `bin.ts` — dispatches to `serve` or a CLI subcommand.
- `main.ts` — headless option, remote listener wiring, machine handlers.

**Packaging**
- `scripts/build-headless.mjs` *(new)* — the Linux headless tarball.
- `packaging/headless/` *(new)* — `threadgarden` launcher, `install.sh`, `threadgarden.service`.

**Desktop shell** (`apps/desktop/src-tauri/src/`)
- `secrets.rs` — machine device tokens next to the API key.
- `lib.rs` — `machine_token_get/set/clear` commands.

**Desktop UI** (`apps/desktop/src/lib/`)
- `native.ts` — `machineTokens`.
- `service/client.ts` — `acceptProtocol` option, `hello` result kept.
- `state/machines.svelte.ts` *(new)* — paired machines, one relay client each, statuses.
- `state/scope.ts` *(new)* — `MachineScope` and `createScope()`.
- `state/merged-list.svelte.ts` *(new)* — merged cross-machine chat lists.
- `state/refs.ts` *(new)* — `ChatRef`, `chatKey()`, `parseChatKey()`.
- `state/app.ts`, `state/context.ts`, `state/tabs.svelte.ts`, `state/agents.svelte.ts` — scopes and keys.
- `components/layout/PlacesColumn.svelte`, `MachineHeading.svelte` *(new)*, `ChatList.svelte`, `ChatListRow.svelte`, `AgentsStrip.svelte`, `ChatPane.svelte`; `components/chat/ChatHeader.svelte`, `ChatView.svelte`; `components/NewChatDialog.svelte`, `QuickSwitcher.svelte`, `SettingsDialog.svelte`, `MachinesSettings.svelte` *(new)*, `AddMachineDialog.svelte` *(new)*.
- `notifications.ts` — one attention source per scope.

**Docs**
- `docs/remote-machines.md` *(new)* — owner setup guide (Ubuntu and pairing; the bridge part comes in plan 4).
- `docs/architecture.md`, `README.md`, `CONTRIBUTING.md` (local-only methods note).

---

## Service and protocol

### Task 1: Protocol 5 and machine identity

**Files:**
- Create: `packages/protocol/src/machines.ts`, `packages/service/src/machine/identity.ts`, `packages/service/test/machine/identity.test.ts`
- Modify: `packages/protocol/src/version.ts:12`, `packages/protocol/src/methods.ts:36-39`, `packages/protocol/src/index.ts`, `packages/protocol/test/schemas.test.ts:51,80-140`, `packages/service/src/main.ts:172-175`, `apps/desktop/src-tauri/src/service.rs:18` (constant and its text test), `apps/desktop/src/lib/service/client.ts:216-222` (sends `client`, keeps exact check for now)

**Interfaces:**
- Produces:
  - `PROTOCOL_VERSION = 5`; `REMOTE_PROTOCOL_RANGE = { min: 4, max: 6 } as const`; `acceptsRemoteProtocol(v: number): boolean`.
  - `MachineInfoSchema = z.object({ id: z.string(), name: z.string(), platform: z.enum(['win32','darwin','linux']), headless: z.boolean(), home: z.string(), capabilities: z.array(z.string()) })`; `type MachineInfo`.
  - `CAPABILITIES = ['remote'] as const` in this plan (plans 2–4 add `projects`, `move`, `power`).
  - `hello` result: `{ serviceVersion, protocolVersion, machine?: MachineInfo }` (`machine` optional so a protocol-4 service still parses).
  - Methods: `machine.get` (`{}` → `MachineInfo`), `machine.rename` (`{ name: z.string().trim().min(1).max(40) }` → `MachineInfo`).
  - `loadMachineIdentity(db: Db, fallbackName: string): { id: string; name: string }` and `renameMachine(db: Db, name: string): { id; name }` in `machine/identity.ts`; keys `machine:id` and `machine:name` in `ui_state`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/service/test/machine/identity.test.ts
it('creates a machine id once and keeps it', () => {
  const db = openTestDb();
  const a = loadMachineIdentity(db, 'ubuntu-pc');
  expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.name).toBe('ubuntu-pc');
  expect(loadMachineIdentity(db, 'other').id).toBe(a.id);
});
it('renames the machine', () => {
  const db = openTestDb();
  loadMachineIdentity(db, 'ubuntu-pc');
  expect(renameMachine(db, 'Ubuntu PC').name).toBe('Ubuntu PC');
  expect(loadMachineIdentity(db, 'x').name).toBe('Ubuntu PC');
});
// packages/protocol/test/schemas.test.ts
expect(PROTOCOL_VERSION).toBe(5);
expect([3, 4, 5, 6, 7].map(acceptsRemoteProtocol)).toEqual([false, true, true, true, false]);
// main.test.ts: hello carries the machine
const hello = await client.call('hello', { protocolVersion: 5, client: 't' });
expect(hello.machine).toMatchObject({ platform: process.platform, headless: false, capabilities: ['remote'] });
```

Add `machine.get` and `machine.rename` to the expected method list in `schemas.test.ts`. `openTestDb()` is `openDb(join(mkdtemp, 'db'))` as in `test/history/db.test.ts`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @threadgarden/protocol test && pnpm --filter @threadgarden/service exec vitest run test/machine/identity.test.ts test/main.test.ts`
Expected: FAIL (`PROTOCOL_VERSION` is 4; `loadMachineIdentity` not found).

- [ ] **Step 3: Implement**

Bump the constant in `version.ts` (extend its history comment: "5 — machines: machine identity in hello, devices, pairing, relay") and in `service.rs`. `fallbackName` is `os.hostname()`. `home` is `os.homedir()`. `headless` comes from `StartOptions.headless` (Task 5; default `false` now). Without a db (no adapter), `hello` omits `machine`.

- [ ] **Step 4: Run the tests again**

Run: the Step 2 command plus `cd apps/desktop/src-tauri && cargo test protocol`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(protocol)!: protocol 5 with machine identity in hello"
```

### Task 2: Device registry and pairing codes

**Files:**
- Create: `packages/service/src/machine/devices.ts`, `packages/service/test/machine/devices.test.ts`
- Modify: `packages/service/src/history/migrations.ts` (append a step), `packages/protocol/src/machines.ts`

**Interfaces:**
- Consumes: `Db` (`opened.raw`).
- Produces:
  - Migration step (comment `// remote machines: paired devices`): `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen INTEGER)`.
  - `DeviceSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.number(), lastSeen: z.number().nullable() })`.
  - `class DeviceRegistry { constructor(db: DatabaseSync, opts?: { now?: () => number; random?: (n: number) => Buffer }); createPairingCode(): { code: string; expiresAt: number }; proof(code: string, fingerprint256: string): string | null; claim(code: string, deviceName: string): { deviceId: string; token: string } | { error: 'PAIRING_INVALID' | 'PAIRING_EXPIRED' }; verify(token: string): Device | null; touch(deviceId: string): void; list(): Device[]; revoke(deviceId: string): boolean; onRevoke(cb: (deviceId: string) => void): () => void }`.
  - Constants: `PAIRING_CODE_TTL_MS = 5 * 60_000`, `PAIRING_MAX_FAILURES = 5`, `PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'`, code length 12, shown and accepted as `XXXX-XXXX-XXXX` (dashes, spaces and case ignored on input).

`proof(code, fp)` returns `HMAC-SHA256(key = normalised code, msg = fp)` as hex when the code is live, else `null`. The client checks it before it sends the code (Task 6), so a man in the middle presenting its own certificate cannot produce a valid proof. Tokens are 32 random bytes as hex; only `sha256(token)` is stored; `verify` compares hashes with `timingSafeEqual`. Only one pairing code is live at a time; creating a new one replaces the old. A failed claim counts against the live code; the fifth failure deletes it.

- [ ] **Step 1: Write the failing tests**

```ts
it('issues a token for a live code once', () => {
  const r = registry();
  const { code } = r.createPairingCode();
  const ok = r.claim(code.toLowerCase().replaceAll('-', ' '), 'Gaming PC');
  expect(ok).toMatchObject({ deviceId: expect.any(String), token: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(r.claim(code, 'again')).toEqual({ error: 'PAIRING_INVALID' });
  expect(r.verify((ok as { token: string }).token)?.name).toBe('Gaming PC');
});
it('expires codes after 5 minutes', () => {
  const r = registry({ now: () => t });
  const { code } = r.createPairingCode();
  t += 5 * 60_000 + 1;
  expect(r.claim(code, 'x')).toEqual({ error: 'PAIRING_EXPIRED' });
  expect(r.proof(code, 'fp')).toBeNull();
});
it('kills the code after five wrong claims', () => {
  const r = registry();
  const { code } = r.createPairingCode();
  for (let i = 0; i < 5; i++) r.claim('AAAA-AAAA-AAAA', 'x');
  expect(r.claim(code, 'x')).toEqual({ error: 'PAIRING_INVALID' });
});
it('proves the code over the certificate fingerprint', () => {
  const r = registry();
  const { code } = r.createPairingCode();
  expect(r.proof(code, 'AA:BB')).toBe(createHmac('sha256', code.replaceAll('-', '')).update('AA:BB').digest('hex'));
});
it('stores only token hashes and revokes', () => {
  const r = registry();
  const { token, deviceId } = r.claim(r.createPairingCode().code, 'x') as { token: string; deviceId: string };
  expect(JSON.stringify(db.prepare('SELECT * FROM devices').all())).not.toContain(token);
  const seen: string[] = []; r.onRevoke((id) => seen.push(id));
  expect(r.revoke(deviceId)).toBe(true);
  expect(r.verify(token)).toBeNull();
  expect(seen).toEqual([deviceId]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @threadgarden/service exec vitest run test/machine/devices.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `DeviceRegistry` and the migration step**

Pairing codes live in memory only (a restart invalidates them).

- [ ] **Step 4: Run the tests again, plus `test/history/db.test.ts`**

Expected: PASS.

- [ ] **Step 5: Commit** — `feat(service): device registry with one-time pairing codes`

### Task 3: TLS identity and listen addresses

**Files:**
- Create: `packages/service/src/machine/tls.ts`, `packages/service/src/machine/interfaces.ts`, `packages/service/test/machine/tls.test.ts`, `packages/service/test/machine/interfaces.test.ts`
- Modify: `packages/service/package.json` (dependency `selfsigned` `^5.5.0`)

**Interfaces:**
- Produces:
  - `loadOrCreateTlsIdentity(dataDir: string, commonName: string): Promise<TlsIdentity>` with `type TlsIdentity = { keyPem: string; certPem: string; fingerprint256: string }`. Files `<dataDir>/tls/key.pem` and `<dataDir>/tls/cert.pem`, written atomically with mode `0o600` (same temp-and-rename pattern as `writeDiscovery`); created once and reused. RSA 2048 or P-256, validity 20 years, `fingerprint256` in Node's format (`AA:BB:…`, as `X509Certificate.fingerprint256`).
  - `privateListenAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[]`: IPv4, not internal, in 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 or 100.64.0.0/10; sorted, de-duplicated.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates the identity once, private files, and reuses it', async () => {
  const a = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
  const b = await loadOrCreateTlsIdentity(dir, 'ubuntu-pc');
  expect(b).toEqual(a);
  expect(new X509Certificate(a.certPem).fingerprint256).toBe(a.fingerprint256);
  if (process.platform !== 'win32') expect((await stat(join(dir, 'tls', 'key.pem'))).mode & 0o777).toBe(0o600);
});
it('listens only on private IPv4 addresses', () => {
  expect(privateListenAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    wlan0: [{ address: '192.168.1.40', family: 'IPv4', internal: false } as never, { address: 'fe80::1', family: 'IPv6', internal: false } as never],
    tun0: [{ address: '100.64.3.2', family: 'IPv4', internal: false } as never],
    eth9: [{ address: '85.70.1.2', family: 'IPv4', internal: false } as never, { address: '172.32.0.1', family: 'IPv4', internal: false } as never],
  })).toEqual(['100.64.3.2', '192.168.1.40']);
});
```

- [ ] **Step 2: Run them to see them fail** — `pnpm --filter @threadgarden/service exec vitest run test/machine` → FAIL.
- [ ] **Step 3: Implement both modules** (wrap `selfsigned` behind `loadOrCreateTlsIdentity`; nothing else imports it).
- [ ] **Step 4: Run the tests again** → PASS. Also `pnpm --filter @threadgarden/service build` to confirm the bundle still builds as one file.
- [ ] **Step 5: Commit** — `feat(service): TLS identity and private listen addresses`

### Task 4: Remote listener

**Files:**
- Create: `packages/service/src/server/remote-server.ts`, `packages/service/src/server/handlers/machines.ts`, `packages/service/test/server/remote-server.test.ts`
- Modify: `packages/service/src/server/router.ts` (ctx origin, local-only), `packages/service/src/server/ws-server.ts:79-90` (passes `origin: 'local'`), `packages/protocol/src/methods.ts`

**Interfaces:**
- Consumes: `DeviceRegistry` (Task 2), `TlsIdentity`, `privateListenAddresses` (Task 3), `Router`.
- Produces:
  - `type HandlerCtx = { clientId: string; origin: 'local' | 'remote'; deviceId?: string }`.
  - `Router.register(m, h, opts?: { localOnly?: boolean })`; dispatching a local-only method with `origin: 'remote'` answers `{ code: 'FORBIDDEN' }`. Local-only in this plan: `pairing.create`, `devices.list`, `devices.revoke`, `machine.rename`, `service.shutdown`, `auth.setApiKey`, and every `machines.*` method (Task 6).
  - Methods: `pairing.create` (`{}` → `{ code, expiresAt }`), `devices.list` (`{}` → `Device[]`), `devices.revoke` (`{ deviceId }` → `{ revoked: boolean }`), `pair.proof` (`{ code }` → `{ proof: string, machine: MachineInfo }`), `pair.claim` (`{ code, deviceName }` → `{ deviceId, token, machine: MachineInfo }`).
  - `startRemoteServer(opts: { addresses: string[]; port: number; tls: TlsIdentity; devices: DeviceRegistry; router: Router; onClientCountChange(n: number): void; onError?(err: unknown): void }): Promise<{ addresses: string[]; port: number; broadcast(e: EventMsg): void; close(): Promise<void> }>`. Default port `REMOTE_PORT = 47380`.
  - Subprotocols on the remote listener: `threadgarden-device.<token>` (full protocol, `origin: 'remote'`, `deviceId` set, every event broadcast to it) and `threadgarden-pair` (only `hello`, `pair.proof` and `pair.claim`; any other method answers `FORBIDDEN`; no events). Anything else closes with 4401. A revoked device's sockets close with **4403** at once (`devices.onRevoke`).
  - `pair.proof` uses the listener's own `tls.fingerprint256`.

- [ ] **Step 1: Write the failing tests** (real `wss` on `127.0.0.1` is not allowed by `privateListenAddresses`; tests pass `addresses: ['127.0.0.1']` directly to `startRemoteServer`, which does not filter — filtering happens in `main.ts`)

```ts
it('refuses a connection without a known device token', async () => {
  expect(await closeCode(await openTls(s, 'threadgarden-device.nope'))).toBe(4401);
});
it('serves the full protocol to a paired device with origin remote', async () => {
  const ws = await openTls(s, `threadgarden-device.${token}`);
  expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machineId } });
  expect(await call(ws, 'pairing.create', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
});
it('pairs: proof, then claim, on the pairing subprotocol only', async () => {
  const { code } = devices.createPairingCode();
  const ws = await openTls(s, 'threadgarden-pair');
  const { result } = await call(ws, 'pair.proof', { code });
  expect(result.proof).toBe(createHmac('sha256', code.replaceAll('-', '')).update(tls.fingerprint256).digest('hex'));
  expect((await call(ws, 'pair.claim', { code, deviceName: 'Gaming PC' })).result.token).toMatch(/^[0-9a-f]{64}$/);
  expect(await call(ws, 'machine.get', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
});
it('closes a revoked device with 4403', async () => {
  const ws = await openTls(s, `threadgarden-device.${token}`);
  const closed = closeCode(ws);
  devices.revoke(deviceId);
  expect(await closed).toBe(4403);
});
it('broadcasts events to devices but not to pairing sockets', async () => { /* push via s.broadcast, expect on device ws only */ });
```

`openTls(s, protocol)` uses `new WebSocket('wss://127.0.0.1:' + s.port, [protocol], { rejectUnauthorized: false })`.

- [ ] **Step 2: Run them to see them fail** → FAIL.
- [ ] **Step 3: Implement** `startRemoteServer` (one `https.createServer({ key, cert })` + `WebSocketServer({ server })` per address, all on the same port; `maxPayload: MAX_REQUEST_BYTES`; same frame handling as `ws-server.ts` — extract the shared frame loop into a helper both servers use rather than copying it), the router's `localOnly` and `origin`, and `registerMachineHandlers(router, deps: { db, devices, identity, tls?, onRenamed? })`.
- [ ] **Step 4: Run the tests again, plus `test/ws-server.test.ts`** → PASS.
- [ ] **Step 5: Commit** — `feat(service): TLS listener for paired devices and pairing`

### Task 5: Headless mode and the CLI

**Files:**
- Create: `packages/service/src/cli.ts`, `packages/service/test/cli.test.ts`
- Modify: `packages/service/src/bin.ts`, `packages/service/src/main.ts` (`StartOptions`, startup, idle tick at L665-674, `close()`), `packages/service/test/main.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `StartOptions.headless?: boolean` and `StartOptions.remote?: { port?: number; addresses?: string[] }`. With `headless: true`: the idle tick keeps running (holds, scheduled sends) but **never exits**; the remote listener starts on `privateListenAddresses(os.networkInterfaces())` (or `remote.addresses` in tests) at `remote.port ?? REMOTE_PORT`; `hello.machine.headless` is `true`. Without `headless`, no remote listener (this plan).
  - `ServiceHandle.remote?: { addresses: string[]; port: number }`. `service.json` gains optional `remotePort` and `remoteAddresses` (the Rust `Discovery` struct ignores unknown fields — check that its serde attributes allow it; if not, add `#[serde(default)]` fields).
  - The local server's broadcast and the remote server's broadcast are combined into `broadcastRef.fn`; `onClientCountChange` sums both servers.
  - `parseArgs(argv: string[]): Command` where `type Command = { kind: 'serve'; headless: boolean; port?: number } | { kind: 'pair' } | { kind: 'status' } | { kind: 'devices' } | { kind: 'revoke'; deviceId: string } | { kind: 'rename'; name: string } | { kind: 'help' } | { kind: 'error'; message: string }`. No arguments means `serve` (what the desktop shell runs today).
  - `runCli(cmd: Command, deps: { dataDir: string; out: (s: string) => void; connect?: typeof connectLocal }): Promise<number>` — every subcommand except `serve` reads `service.json`, connects to `ws://127.0.0.1:<port>` with the local token and calls the method; exit code 0 on success, 1 when the service is not running ("Threadgarden is not running. Start it with: systemctl --user start threadgarden").
  - Output of `pair`: `Pairing code: ABCD-EFGH-JKLM (valid for 5 minutes)` then `Address: <first remote address>:<port>` and `Name: <machine name>`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(parseArgs([])).toEqual({ kind: 'serve', headless: false });
expect(parseArgs(['serve', '--headless', '--port', '47390'])).toEqual({ kind: 'serve', headless: true, port: 47390 });
expect(parseArgs(['revoke'])).toEqual({ kind: 'error', message: 'Usage: threadgarden revoke <device-id>' });
expect(parseArgs(['rename', 'Ubuntu', 'PC'])).toEqual({ kind: 'rename', name: 'Ubuntu PC' });
// runCli against a started service in a temp data dir
expect(await runCli({ kind: 'pair' }, { dataDir, out })).toBe(0);
expect(lines.join('\n')).toMatch(/Pairing code: [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4} \(valid for 5 minutes\)/);
expect(await runCli({ kind: 'status' }, { dataDir: emptyDir, out })).toBe(1);
// main.test.ts
it('never exits on idle when headless', async () => { /* same injected clock/setInterval pattern as L328-373; advance 31 min; expect not closed; expect scheduled check still called */ });
it('starts the remote listener only when headless', async () => { /* headless with remote.addresses ['127.0.0.1'] → svc.remote.port defined; non-headless → svc.remote undefined */ });
```

- [ ] **Step 2: Run them to see them fail** → FAIL.
- [ ] **Step 3: Implement** `cli.ts`, the `bin.ts` dispatch (keep the existing serve path byte-for-byte for no arguments), the headless options in `main.ts`, and loading the TLS identity (`loadOrCreateTlsIdentity(dataDir, machineName)`) only when the remote listener starts.
- [ ] **Step 4: Run the service suite** — `pnpm --filter @threadgarden/service test` → PASS (including `test/e2e/read-only.test.ts`).
- [ ] **Step 5: Commit** — `feat(service): headless mode and the threadgarden CLI`

### Task 6: Pairing client, paired machines and the relay

**Files:**
- Create: `packages/service/src/machine/pairing-client.ts`, `packages/service/src/machine/paired-machines.ts`, `packages/service/src/server/relay.ts`, `packages/service/test/server/relay.test.ts`, `packages/service/test/machine/pairing-client.test.ts`
- Modify: `packages/service/src/server/ws-server.ts` (route `/relay`), `packages/service/src/history/migrations.ts`, `packages/service/src/server/handlers/machines.ts`, `packages/protocol/src/machines.ts`, `packages/protocol/src/methods.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - Migration step (`// remote machines: machines this one connects to`): `CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL, cert_pem TEXT NOT NULL, fingerprint TEXT NOT NULL, added_at INTEGER NOT NULL, sort INTEGER NOT NULL DEFAULT 0)`.
  - `PairedMachineSchema = z.object({ id, name, address, port: z.number(), fingerprint: z.string(), addedAt: z.number(), unlocked: z.boolean() })` (`cert_pem` stays in the service).
  - `class PairedMachines { constructor(db); list(): PairedMachine[]; get(id): (PairedMachine & { certPem: string }) | null; add(m): void; update(id, patch: { name?: string; address?: string; port?: number }): PairedMachine; remove(id): void; unlock(id, token): void; token(id): string | null }` — tokens in memory only, like the API key.
  - `pairWithMachine(opts: { address: string; port: number; code: string; deviceName: string; timeoutMs?: number }): Promise<{ machine: MachineInfo; certPem: string; fingerprint: string; token: string }>` errors (as `ServiceError` codes): `PAIRING_UNREACHABLE`, `PAIRING_PROOF_FAILED` (proof absent or wrong: the code is never sent), `PAIRING_INVALID`, `PAIRING_EXPIRED`. Steps: connect `wss` with `rejectUnauthorized: false` and subprotocol `threadgarden-pair`; read the peer certificate (`socket.getPeerCertificate(true)`, convert `raw` to PEM, `fingerprint256`); `pair.proof { code }`; compare with the local HMAC in constant time; only then `pair.claim`.
  - Methods (all local-only): `machines.list` (`{}` → `PairedMachine[]`), `machines.pair` (`{ address, port?: number (default 47380), code, deviceName }` → `{ machine: PairedMachine; token: string }`; stores the machine, unlocks it, returns the token once so the UI can put it in the keychain), `machines.unlock` (`{ machineId, token }` → `{}`), `machines.update` (`{ machineId, name?, address?, port? }` → `PairedMachine`), `machines.remove` (`{ machineId, revoke: boolean }` → `{}`; with `revoke`, it first tries `devices.revoke` for its own device on the remote over a short-lived link, ignoring failure). Event `machines.changed` (`PairedMachine[]`).
  - **Relay.** The local server accepts `GET /relay?machine=<id>` with the local token subprotocol (`threadgarden.<token>`). It opens a `RemoteLink` to the machine: `wss://<address>:<port>` with subprotocol `threadgarden-device.<token>`, `ca: [certPem]`, `checkServerIdentity: (_h, cert) => cert.fingerprint256 === fingerprint ? undefined : new Error('PIN_MISMATCH')`. Frames are piped verbatim both ways; the relay never parses them. Close codes to the UI: **4404** unknown or locked machine, **4409** certificate mismatch (the token was not sent: verification happens in the TLS handshake before the upgrade request), **4403** the remote refused the token, **4502** unreachable or the link dropped. A UI close closes the link and vice versa.
  - The relay counts as a client for the local idle exit.

- [ ] **Step 1: Write the failing tests** (a remote service = `startService({ headless: true, remote: { addresses: ['127.0.0.1'], port: 0 } … })`; the local one = a normal `startService`)

```ts
it('pairs with a headless machine and relays its protocol', async () => {
  const { code } = await localCall(remote, 'pairing.create', {});
  const { machine, token } = await localCall(local, 'machines.pair', { address: '127.0.0.1', port: remote.remote!.port, code, deviceName: 'Gaming PC' });
  const ws = await openRelay(local, machine.id);
  expect(await call(ws, 'machine.get', {})).toMatchObject({ result: { id: machine.id, headless: true } });
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});
it('never sends the code when the proof does not match the certificate', async () => {
  // a fake pairing server whose pair.proof answers with a proof for another fingerprint
  await expect(pairWithMachine({ address: '127.0.0.1', port: fake.port, code, deviceName: 'x' })).rejects.toMatchObject({ code: 'PAIRING_PROOF_FAILED' });
  expect(fake.calls('pair.claim')).toHaveLength(0);
});
it('closes 4409 and sends no token when another machine answers at the address', async () => {
  await localCall(local, 'machines.update', { machineId, port: otherHeadless.remote!.port });
  expect(await closeCode(await openRelay(local, machineId))).toBe(4409);
  expect(otherHeadless.upgradeRequests()).toHaveLength(0);
});
it('closes 4404 for a locked machine after a local restart', async () => { /* restart local service; openRelay → 4404; machines.unlock → relay works */ });
it('closes 4502 when the remote goes away', async () => { /* remote.close(); expect relay closes 4502 */ });
it('removes and revokes', async () => { /* machines.remove { revoke: true } → remote devices.list (local call on remote) no longer has the device */ });
```

- [ ] **Step 2: Run them to see them fail** → FAIL.
- [ ] **Step 3: Implement** the pairing client, `PairedMachines`, the handlers and the relay. `upgradeRequests()` in the test is a counter on the fake server's `upgrade` event.
- [ ] **Step 4: Run the service suite** → PASS.
- [ ] **Step 5: Commit** — `feat(service): pair with machines and relay to them over pinned TLS`

### Task 7: Headless Linux package

**Files:**
- Create: `scripts/build-headless.mjs`, `packaging/headless/threadgarden` (sh), `packaging/headless/install.sh`, `packaging/headless/threadgarden.service`, `packaging/headless/test/install.test.ts` (run by the root vitest workspace or `packages/service` — follow wherever `scripts/` tests live; if none, put it under `packages/service/test/packaging/`)
- Modify: `.github/workflows/ci.yml` (Linux job builds the tarball and uploads it as an artifact), root `package.json` (`"build:headless": "node scripts/build-headless.mjs"`)

**Interfaces:**
- Consumes: `packages/service/dist/service.mjs` (`pnpm --filter @threadgarden/service build`), `scripts/fetch-node-sidecar.mjs` (targets `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`).
- Produces:
  - `dist-headless/threadgarden-headless-<version>-linux-<x64|arm64>.tar.gz` containing `threadgarden-headless-<version>/{bin/node, bin/threadgarden, lib/service.mjs, install.sh, threadgarden.service, VERSION}` and a `.sha256` file next to the tarball.
  - `bin/threadgarden`: `exec "$(dirname "$0")/node" --disable-warning=ExperimentalWarning "$(dirname "$0")/../lib/service.mjs" "$@"` (resolving symlinks).
  - `install.sh` (POSIX sh, idempotent, never needs root except one `loginctl enable-linger "$USER"` via `sudo`, which it explains before running): copies the release to `~/.local/share/threadgarden-headless/<version>`, points `~/.local/share/threadgarden-headless/current` at it, links `~/.local/bin/threadgarden`, writes `~/.config/systemd/user/threadgarden.service`, runs `systemctl --user daemon-reload` and `systemctl --user enable --now threadgarden`, then prints the next step (`threadgarden pair`). The commands `systemctl`, `loginctl` and `sudo` are taken from `SYSTEMCTL`, `LOGINCTL` and `SUDO` env vars when set (tests).
  - The unit: `ExecStart=%h/.local/share/threadgarden-headless/current/bin/threadgarden serve --headless`, `Restart=on-failure`, `RestartSec=5`, `Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`, `WantedBy=default.target`.

- [ ] **Step 1: Write the failing test**

```ts
it('installs into a temp HOME and enables the user unit', async () => {
  const { code, stdout } = await sh(`${release}/install.sh`, { HOME: home, SYSTEMCTL: 'echo systemctl', LOGINCTL: 'echo loginctl', SUDO: '' });
  expect(code).toBe(0);
  expect(await readlink(join(home, '.local/bin/threadgarden'))).toContain('threadgarden-headless/current/bin/threadgarden');
  expect(await readFile(join(home, '.config/systemd/user/threadgarden.service'), 'utf8')).toContain('serve --headless');
  expect(stdout).toContain('systemctl --user enable --now threadgarden');
  expect(stdout).toContain('threadgarden pair');
});
```

Skip the test on Windows (`it.skipIf(process.platform === 'win32')`). `release` is a directory the test assembles from `packaging/headless/` with a stub `bin/node`.

- [ ] **Step 2: Run it to see it fail** → FAIL.
- [ ] **Step 3: Implement** the build script, the three packaging files and the CI step.
- [ ] **Step 4: Run it again, and `pnpm build:headless` on Linux CI** → PASS; the artifact is listed in the CI run.
- [ ] **Step 5: Commit** — `build: headless Linux package with a systemd user unit`

---

## Desktop

### Task 8: Device tokens in the keychain

**Files:**
- Modify: `apps/desktop/src-tauri/src/secrets.rs`, `apps/desktop/src-tauri/src/lib.rs:148-157`, `apps/desktop/src/lib/native.ts`, `apps/desktop/tests/native.test.ts`

**Interfaces:**
- Produces:
  - Rust: `pub fn machine_token_get(machine_id: &str) -> Result<Option<String>, String>`, `machine_token_set(machine_id: &str, token: &str)`, `machine_token_clear(machine_id: &str)`; keychain service `threadgarden`, user `machine:<machine_id>`; `machine_id` must match `^[0-9a-f-]{36}$` else `"machine-id-invalid"`.
  - Tauri commands `machine_token_get(machine_id: String)`, `machine_token_set(machine_id: String, token: String)`, `machine_token_clear(machine_id: String)`.
  - TS: `export const machineTokens: { get(id: string): Promise<string | null>; set(id: string, token: string): Promise<void>; clear(id: string): Promise<void> }` — in-memory `Map` outside Tauri.

- [ ] **Step 1: Failing tests** — Rust with `FakeStore`: set/get/clear round-trip under `machine:<id>`; an invalid id is refused; the API-key entry is untouched. TS: the browser stub round-trips.
- [ ] **Step 2: Run** `cargo test secrets` and `pnpm --filter desktop exec vitest run tests/native.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run again** → PASS; `cargo clippy --all-targets -- -D warnings` clean.
- [ ] **Step 5: Commit** — `feat(desktop): keep machine device tokens in the OS keychain`

### Task 9: Machines store and relay clients

**Files:**
- Create: `apps/desktop/src/lib/state/machines.svelte.ts`, `apps/desktop/tests/state/machines.test.ts`
- Modify: `apps/desktop/src/lib/service/client.ts` (options, hello), `apps/desktop/tests/service/client.test.ts`, `apps/desktop/tests/service/fake-ws.ts` (close codes, multiple servers)

**Interfaces:**
- Consumes: `machines.*` methods (Task 6), `machineTokens` (Task 8), `ServiceClient`.
- Produces:
  - `ClientOptions.acceptProtocol?: (v: number) => boolean` (default exact match); `ClientOptions.onClose?: (code: number) => 'retry' | 'stop'` (default retry); `client.hello: Result<'hello'> | null` (the last hello).
  - `type MachineStatus = 'connecting' | 'on' | 'unreachable' | 'locked' | 'incompatible' | 'mismatch' | 'refused'` (from close codes: 4502 → `unreachable` and keep retrying with backoff; 4404 → `locked`; 4409 → `mismatch`, stop; 4403 → `refused`, stop; incompatible hello → `incompatible`, stop).
  - `type MachineEntry = { id: string; name: string; address: string; port: number; local: boolean; status: MachineStatus; info: MachineInfo | null; client: ServiceClient }`.
  - `class MachinesState { list: MachineEntry[] /* This PC first, then paired by sort */; local: MachineEntry | null; get(id: string): MachineEntry | undefined; init(localApi: Api, localClient: ServiceClient, opts: { relayUrl(machineId: string): string; localToken(): string; tokens?: typeof machineTokens; makeClient?: (o: ClientOptions) => ServiceClient }): void; pair(p: { address: string; port?: number; code: string; deviceName: string }): Promise<MachineEntry>; rename(id: string, name: string): Promise<void>; setAddress(id: string, address: string, port?: number): Promise<void>; remove(id: string): Promise<void>; onAdded(cb: (m: MachineEntry) => void): () => void; onRemoved(cb: (id: string) => void): () => void }`.
  - On every local `onOpen`: `machines.list`, then for each machine `machines.unlock` with the keychain token (missing token → `locked`), then connect its client to `relayUrl(id)` with the local token and `acceptProtocol: acceptsRemoteProtocol`. `pair()` stores the returned token with `machineTokens.set` before anything else. `remove()` calls `machines.remove { revoke: true }`, clears the keychain entry and closes the client.
  - The **This PC** entry wraps the existing local client; its `id` and `name` come from the local `hello.machine` (`name` shown as "This PC" in the UI regardless of the hostname).

- [ ] **Step 1: Failing tests**

```ts
it('unlocks and connects every paired machine through the relay', async () => {
  const { machines, servers } = await setupMachines([{ id: M1, name: 'Ubuntu PC' }], { tokens: { [M1]: 'tok' } });
  await vi.waitFor(() => expect(machines.get(M1)?.status).toBe('on'));
  expect(servers.local.calls('machines.unlock')).toEqual([{ machineId: M1, token: 'tok' }]);
  expect(servers.remote(M1).url).toBe(`ws://127.0.0.1:${LOCAL_PORT}/relay?machine=${M1}`);
});
it('reconnects after the remote drops and replays reconnect handlers', async () => {
  const reconnects = vi.fn(); machines.get(M1)!.client.onReconnect(reconnects);
  servers.remote(M1).drop(4502);
  expect(machines.get(M1)?.status).toBe('unreachable');
  await vi.advanceTimersByTimeAsync(300);
  expect(machines.get(M1)?.status).toBe('on');
  expect(reconnects).toHaveBeenCalledOnce();
});
it('unlocks again after the local service restarts', async () => { /* local drop + reopen → machines.unlock called twice */ });
it('stops on a certificate mismatch and says so', async () => { /* drop(4409) → status 'mismatch', no further connection attempts */ });
it('accepts a remote on protocol 4 or 6 but not 3', async () => { /* hello protocolVersion 4 → on; 3 → incompatible */ });
it('pairs: keychain first, then connect', async () => { /* pair() → tokens.set called before client connect */ });
```

- [ ] **Step 2: Run** `pnpm --filter desktop exec vitest run tests/state/machines.test.ts tests/service/client.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `relayUrl` comes from the local `ServiceConnection` (`ws://127.0.0.1:${port}/relay?machine=${id}`).
- [ ] **Step 4: Run again** → PASS.
- [ ] **Step 5: Commit** — `feat(ui): machines store with one relayed client per machine`

### Task 10: Machine scopes and chat references

**Files:**
- Create: `apps/desktop/src/lib/state/scope.ts`, `apps/desktop/src/lib/state/refs.ts`, `apps/desktop/tests/state/scope.test.ts`
- Modify: `apps/desktop/src/lib/state/app.ts:40-79`, `apps/desktop/src/lib/state/context.ts`, `apps/desktop/src/lib/state/tabs.svelte.ts`, `apps/desktop/src/lib/state/places.svelte.ts` (`Place` gains `machineId` for `kind: 'project'`), `apps/desktop/tests/layout/harness.ts`

**Interfaces:**
- Consumes: `MachinesState` (Task 9) and every existing store class.
- Produces:
  - `type ChatRef = { machineId: string; sessionId: string }`; `chatKey(ref: ChatRef): string` → `` `${machineId}/${sessionId}` ``; `parseChatKey(key: string): ChatRef | null`.
  - `type MachineScope = { machineId: string; api: Api; places: PlacesState; sessions: SessionsState; chats: ChatsState; buckets: BucketsState; scheduled: ScheduledState; interaction: InteractionState; yourTurn: YourTurnState }`.
  - `createScope(machineId: string, api: Api, deps: { tabs: TabsState; settings: SettingsState }): MachineScope` — new instances of each class, `init`ed exactly as `wire()` does today. The **This PC** scope uses the existing singletons (so nothing changes for a single-machine user).
  - `AppState` gains `machines: MachinesState`, `scopes: { get(machineId: string): MachineScope | undefined; all(): MachineScope[]; local(): MachineScope }`. Existing `AppState` keys (`places`, `sessions`, `chats`, …) stay and keep pointing at This PC's scope, so components not touched by this plan keep working.
  - `TabsState.open: string[]` now holds chat keys; `active: string | null` is a chat key; `openTab(ref: ChatRef | string)`. `restore()` migrates the stored `'tabs'` ui-state value: entries without `/` get the local machine id prefixed. Tabs of a removed machine close (`machines.onRemoved`).
  - Scopes are created on `machines.onAdded` and dropped on `onRemoved`.

- [ ] **Step 1: Failing tests**

```ts
it('keeps the same session id on two machines apart', async () => {
  const { app } = await setupTwoMachines(); // both fake services return session 's1'
  app.tabs.openTab({ machineId: LOCAL, sessionId: 's1' });
  app.tabs.openTab({ machineId: M1, sessionId: 's1' });
  expect(app.tabs.open).toEqual([`${LOCAL}/s1`, `${M1}/s1`]);
  expect(app.scopes.get(M1)!.chats).not.toBe(app.scopes.local().chats);
});
it('migrates stored tabs without a machine id to This PC', async () => {
  const { app } = await setup((s) => { s.handlers['uiState.get'] = () => ({ value: { open: ['a', 'b'], active: 'b' } }); });
  await app.tabs.restore();
  expect(app.tabs.open).toEqual([`${LOCAL}/a`, `${LOCAL}/b`]);
});
it('closes the tabs of a removed machine', async () => { /* open M1 tab, machines.remove(M1) → tab gone */ });
expect(parseChatKey('m/s')).toEqual({ machineId: 'm', sessionId: 's' });
expect(parseChatKey('nope')).toBeNull();
```

- [ ] **Step 2: Run** the new test and the existing `tests/state` and `tests/layout` suites → new tests FAIL, existing pass.
- [ ] **Step 3: Implement**, updating every `tabs.openTab(sessionId)` call site to pass a `ChatRef` (QuickSwitcher, AgentsStrip, NewChatDialog, notifications, ChatList, your-turn) — with the local machine id where the caller is still single-machine; later tasks switch them to the right machine.
- [ ] **Step 4: Run** `pnpm --filter desktop test` → PASS (all existing tests).
- [ ] **Step 5: Commit** — `refactor(ui): per-machine store scopes and machine-qualified tabs`

### Task 11: Cross-machine lists

**Files:**
- Create: `apps/desktop/src/lib/state/merged-list.svelte.ts`, `apps/desktop/tests/state/merged-list.test.ts`
- Modify: `apps/desktop/src/lib/state/agents.svelte.ts` (`mergeAgents` across scopes), `apps/desktop/src/lib/state/places.svelte.ts` (counts summed for Needs you / Running / buckets), `apps/desktop/src/lib/components/layout/ChatList.svelte`

**Interfaces:**
- Consumes: scopes (Task 10).
- Produces:
  - `type MachineChat = ChatSummary & { machineId: string }`.
  - `class MergedList { items: MachineChat[]; loading: boolean; error: string | null; nextAvailable: boolean; constructor(scopes: () => MachineScope[], place: Place /* needsYou | running | a bucket */); reload(): Promise<void>; loadMore(): Promise<void> }` — asks every connected scope for `sessions.list` with the same place and `PAGE_SIZE`, keeps one cursor per machine, and merges by the same order the service uses for that place (`lastActivity` descending; compare the service's catalog ordering in `packages/service/src/history` and reuse its comparator by exporting it from `@threadgarden/protocol` if it is not there yet). `loadMore()` fetches the next page only from machines whose buffered items are exhausted. A machine that errors or is not `on` is skipped and listed in `skipped: string[]` (machine names) for the list to show "Ubuntu PC is unreachable — its chats are missing here".
  - `ChatList` uses `MergedList` for cross-machine places and the project's scope `sessions` for project places.
  - `agents.items` become `MachineChat[]`, merged from every scope; `agents.needsYou` and the tray badge are the sum.

- [ ] **Step 1: Failing tests**

```ts
it('merges two machines by last activity and keeps both copies of one id', async () => {
  // LOCAL: s1@t=30, s2@t=10 ; M1: s1@t=20
  await list.reload();
  expect(list.items.map((c) => `${c.machineId}/${c.sessionId}`)).toEqual([`${LOCAL}/s1`, `${M1}/s1`, `${LOCAL}/s2`]);
});
it('pages each machine with its own cursor', async () => { /* PAGE_SIZE 2; M1 has 5; loadMore asks M1 with its cursor only */ });
it('skips an unreachable machine and says which', async () => { /* M1 status unreachable → items from LOCAL only, skipped ['Ubuntu PC'] */ });
it('sums Needs you across machines for the badge and tray', async () => { /* local 2 + M1 3 → places.counts.needsYou 5; setTrayNeedsYou(5) */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter desktop test` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): Needs you, Running and buckets across machines`

### Task 12: Places column with machine groups (layout A)

**Files:**
- Create: `apps/desktop/src/lib/components/layout/MachineHeading.svelte`, `apps/desktop/tests/layout/machines-layout.test.ts`
- Modify: `apps/desktop/src/lib/components/layout/PlacesColumn.svelte:196-238`, `ChatListRow.svelte:132-134`, `AgentsStrip.svelte`, `apps/desktop/src/lib/components/QuickSwitcher.svelte`

**Interfaces:**
- Consumes: `MachinesState`, scopes, `MergedList`.
- Produces:
  - Places column order: Needs you, Running, Analytics, Active / On hold / Archived (all cross-machine, unchanged positions — the spec's "Analytics below the groups" is not applied; keeping today's order avoids moving a place the owner already uses *(builder's call recorded here)*), then **one group per machine**: `MachineHeading` + that scope's projects (pinned/visible as today), its "Missing folders" and "Hidden projects" sub-groups. This PC first. With only This PC paired, the column looks exactly as today except the "Projects" heading reads "This PC".
  - `MachineHeading` props: `{ machine: MachineEntry; collapsed: boolean; onToggle(): void }`. Shows the name (This PC for the local one), a state dot and label: **On** (green), **Connecting…** (amber; statuses `connecting`, and `unreachable` while retrying shows **Unreachable**), and for `mismatch` / `refused` / `locked` / `incompatible` the label **Needs attention** with a tooltip naming the reason ("This address answers as a different machine", "This device was removed on Ubuntu PC", "Pair again", "Different Threadgarden version") and a link opening Settings → Machines. Collapsing a group is remembered in `uiState` key `machines.collapsed`.
  - A machine chip (the same style as the project chip at `ChatListRow.svelte:132-134`) on rows of cross-machine lists, in the agents strip and in quick-switcher hits, only when more than one machine is paired. `ChatListRow` gains `machineName?: string`.
  - `QuickSwitcher` searches every connected scope (`search.quick` in parallel, `QUICK_LIMIT` each, merged by the service's score field, then cut to `QUICK_LIMIT`) and opens hits with their `ChatRef`.

- [ ] **Step 1: Failing component tests**

```ts
it('shows one group per machine with its state', async () => {
  const { context } = await setupTwoMachines({ m1Status: 'on' });
  render(PlacesColumn, { context });
  expect(await screen.findByRole('heading', { name: /this pc/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /ubuntu pc/i })).toBeInTheDocument();
  expect(screen.getByText('On')).toBeInTheDocument();
  expect(within(groupOf('Ubuntu PC')).getByRole('button', { name: /tg-cli/i })).toBeInTheDocument();
});
it('says why a machine needs attention', async () => { /* m1Status 'mismatch' → 'Needs attention' with title 'This address answers as a different machine' */ });
it('shows machine chips only with more than one machine', async () => { /* single machine → no chip in Needs you rows */ });
it('selecting a project under a machine lists that machine’s chats', async () => { /* click tg-cli under Ubuntu PC → ChatList calls sessions.list on M1's fake server only */ });
it('quick switcher finds chats on every machine', async () => { /* search.quick on both servers; Enter opens `${M1}/s9` */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter desktop test` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): machines as groups in the places column`

### Task 13: Chats on a remote machine

**Files:**
- Modify: `apps/desktop/src/lib/components/layout/ChatPane.svelte`, `apps/desktop/src/lib/components/chat/ChatView.svelte`, `apps/desktop/src/lib/components/chat/ChatHeader.svelte:187-254`, `apps/desktop/src/lib/components/NewChatDialog.svelte:87-163`, `apps/desktop/src/lib/notifications.ts`, `apps/desktop/src/lib/state/app.ts` (one `startAttention` per scope)
- Test: `apps/desktop/tests/chat/remote-chat.test.ts`, `apps/desktop/tests/global/notifications.test.ts`

**Interfaces:**
- Consumes: scopes, `ChatRef`, `MachinesState`.
- Produces:
  - `ChatPane` resolves `tabs.active` with `parseChatKey` and renders `ChatView` with `{ ref }` inside a context that sets that machine's scope (`setContext(SCOPE_CONTEXT, scope)` and a `useScope()` helper in `context.ts` that falls back to This PC). Components inside a chat (`ChatView`, `ChatHeader`, composer, activity panel) call `useScope()` instead of `useApp()` for `chats`, `buckets`, `scheduled`, `interaction`, `places`.
  - `ChatHeader` shows a machine chip next to the project chip when more than one machine is paired.
  - `NewChatDialog`: a **Machine** select (`id="new-chat-machine"`) listing machines whose status is `on`, default the machine of the selected project place, else This PC; the folder select lists that scope's projects plus the machine's home folder (`info.home`, label "Home folder"); "Choose folder…" stays This PC only (disabled with the tooltip "Only for This PC" otherwise). `create()` goes through the chosen scope and opens `{ machineId, sessionId }`.
  - Dropping a non-image file into a chat on another machine inserts nothing and shows the composer notice "Files from This PC can't be attached to chats on ‹machine›." Images keep working (they already travel as bytes).
  - Notifications: `startAttention` runs once per scope (started on `machines.onAdded`, stopped on removal); bodies of non-local machines are prefixed `‹machine name› · `; clicking opens the right `ChatRef`; the tray count is the sum from Task 11.

- [ ] **Step 1: Failing tests**

```ts
it('sends a message in a chat on Ubuntu PC through that machine', async () => {
  const { servers } = await renderChat({ machineId: M1, sessionId: 's1' });
  await user.type(screen.getByRole('textbox', { name: /message/i }), 'hi{Enter}');
  expect(servers.remote(M1).calls('chat.send')).toHaveLength(1);
  expect(servers.local.calls('chat.send')).toHaveLength(0);
});
it('starts a new chat on the chosen machine in its home folder', async () => {
  // choose Machine: Ubuntu PC, Folder: Home folder (/home/jiri)
  expect(servers.remote(M1).calls('chat.create')[0]).toMatchObject({ cwd: '/home/jiri' });
  expect(app.tabs.active).toBe(`${M1}/new-id`);
});
it('refuses non-image drops into a remote chat', async () => { /* onFileDrop with C:\\a.txt → notice text, composer unchanged */ });
it('names the machine in notifications from other machines', async () => {
  servers.remote(M1).push('needsYou', { sessionId: 's1', title: 'Scaffold', projectName: 'tg-cli', what: 'needs permission' });
  expect(notify).toHaveBeenCalledWith('Scaffold', 'Ubuntu PC · tg-cli · needs permission', `${M1}/s1`);
});
```

(`notify`'s third argument becomes the chat key; update `native.notify` and the click handler accordingly.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter desktop test` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): run chats on another machine`

### Task 14: Settings → Machines

**Files:**
- Create: `apps/desktop/src/lib/components/MachinesSettings.svelte`, `apps/desktop/src/lib/components/AddMachineDialog.svelte`, `apps/desktop/tests/layout/machines-settings.test.ts`
- Modify: `apps/desktop/src/lib/components/SettingsDialog.svelte` (new `<section aria-labelledby="settings-machines">` between Appearance and Authentication), `apps/desktop/src/lib/state/interaction.svelte.ts` (`addMachineOpen`)

**Interfaces:**
- Consumes: `MachinesState.pair/rename/setAddress/remove`.
- Produces:
  - The section lists This PC (name only) and each paired machine: name (editable inline, saved with `machines.update` — not part of the dialog's Save diff), address and port (editable; saving keeps the pin, so a different machine at the new address is still refused), status, **Remove** (confirm: "Remove Ubuntu PC? This PC forgets it, and Ubuntu PC forgets this PC if it can be reached.").
  - **Add machine…** opens `AddMachineDialog`: fields Address (`ubuntu-pc.local` placeholder), Port (default 47380, under "More"), Pairing code (`XXXX-XXXX-XXXX`), and "This device's name" (default: This PC's hostname). Errors, shown inline: `PAIRING_UNREACHABLE` → "Can't reach ‹address›. Is the machine on and Threadgarden running there?"; `PAIRING_PROOF_FAILED` → "The machine at ‹address› couldn't prove it knows this code. Nothing was sent. Check the address."; `PAIRING_INVALID` → "That code isn't valid. Run `threadgarden pair` on the machine for a new one."; `PAIRING_EXPIRED` → "That code has expired. Run `threadgarden pair` again."; machine already paired (same machine id) → "Already paired as ‹name›." A short hint under the form: "On the other machine, run `threadgarden pair`."

- [ ] **Step 1: Failing tests** — pair success adds the machine to the list and closes the dialog; each error code shows its text; editing the address calls `machines.update` with the new address and keeps the machine id; Remove confirms then calls `machines.remove` with `revoke: true` and clears the keychain token.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter desktop test` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): add, rename and remove machines in Settings`

### Task 15: End-to-end, docs

**Files:**
- Create: `apps/desktop/e2e/machines.spec.ts`, `docs/remote-machines.md`
- Modify: `packages/service/src/testing/mock-main.ts` (`--remote` flag), `apps/desktop/e2e/playwright.config.ts` (a second mock service), `docs/architecture.md` (Processes diagram, Protocol, Security model, a new "Machines" section), `README.md` (Features: a "Remote machines" bullet; Requirements: the headless install), `CONTRIBUTING.md` (local-only methods; the relay never parses frames)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `mock-main.ts --remote --remote-port 47358 --pairing-code TEST-TEST-TEST` starts a headless mock (its own corpus of 20 chats, project `tg-cli`) whose pairing code is fixed for tests (only under the mock entry point).
  - `machines.spec.ts`: pair from Settings with the fixed code against `127.0.0.1:47358` (the mock's remote listener binds `127.0.0.1` when `--remote` is given — test-only flag), see the Ubuntu group with `tg-cli`, open a chat there, send a message and see the scripted reply; a Needs you item from the remote shows with its machine chip.
  - `docs/remote-machines.md`: for the owner — what it does; Ubuntu PC preparation (Wi-Fi connected at boot without login, SSH, a DHCP reservation or `<hostname>.local`); install Claude Code and sign in over SSH; `git`, `gh auth login`; download the headless tarball, check its `.sha256`, run `install.sh`; `threadgarden pair`; in Threadgarden, Settings → Machines → Add machine; troubleshooting by status ("Needs attention" reasons, `systemctl --user status threadgarden`, `journalctl --user -u threadgarden`). Notes that power control comes later.

- [ ] **Step 1: Write the Playwright spec** and run `pnpm --filter desktop test:e2e -- machines` → FAIL.
- [ ] **Step 2: Implement the mock flags** and config → the spec PASSES; the full e2e suite still passes.
- [ ] **Step 3: Write the docs.** Check every command in `docs/remote-machines.md` against the CLI (`parseArgs`) and the install script.
- [ ] **Step 4: Full verification** — `pnpm lint && pnpm typecheck && pnpm test`, `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` in `apps/desktop/src-tauri`, `pnpm --filter desktop test:e2e` → all PASS.
- [ ] **Step 5: Commit** — `docs: remote machines setup guide and architecture`; `test(e2e): pair and chat with a second machine`
