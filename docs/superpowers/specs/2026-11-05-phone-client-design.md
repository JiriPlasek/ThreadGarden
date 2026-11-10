# Threadgarden on the phone: design

## Intent

The owner wants to use their chats from an Android phone the same way they do in
the desktop app, including while away from home. The phone is only a remote
control: it **never runs Claude Code**. Every chat runs on one of the owner's
machines, and the phone connects to them directly, so no other computer has to
be on.

## Goals

1. An Android app showing **all** the owner's machines, including the main PC.
2. The chats as on the desktop: read, reply, answer Claude's questions, new
   chats, the Needs you list, Running, and search across connected machines.
3. An alert the moment Claude needs the owner or finishes, even with the app
   closed.
4. Turn on and shut down a machine that has a plug.
5. Second stage: an Off machine's saved chats and replies that wait, as on the
   desktop since 0.9.0.

## Non-goals, for now

- iPhone. It needs a Mac and a paid developer account.
- The Play Store. The app installs from a file in the GitHub release.
- Analytics, and installing a plug's rules on the bridge from the phone. Setup stays on the desktop; the phone only needs the plug's details.
- Keyboard shortcuts, drag and drop, the tray and start on login.
- A QR code for pairing. Typing the address and code comes first.

## Anti-goals

- **No cloud:** no push service (Google's included), no relay server and no
  account. The Pi and Tailscale stay only the network door, and nothing of
  Threadgarden's runs on the Pi.
- **Claude Code never runs on the phone.**
- **The desktop stays closed to the network unless the owner turns that on.**
- **The phone's constant connection never keeps a machine awake.** Idle shutdown
  behaves as if the phone weren't there.

## Constraints

- Android only, built in CI: neither of the owner's PCs has the Android SDK.
- The phone reaches home through Tailscale and the Pi's subnet route. Tailscale
  on the phone is the owner's job, and the app doesn't manage it.
- The webview can't pin a self-signed certificate, so it stays on loopback, as on
  the desktop.
- Node 22 can't realistically ship on Android, so the phone has no Threadgarden
  service.

## Decisions by the owner

- Android.
- The same chats as the desktop, not a cut-down companion.
- A **permanent notification**: the app stays connected in the background and
  alerts at once, at some cost in battery.
- The main PC appears on the phone too. The limits were accepted: if it's off or
  asleep, the phone can only reach it through a plug; without a plug it shows as
  Off with no Turn on. It has no plug today but could get one.
- The phone gets the plug settings and bridge password by **retyping them once**,
  so no machine changes and the password travels nowhere new.
- The phone never runs Claude Code.

## Calls made by the designer (the owner can overturn these)

- **Two stages.** First the chats on machines that are on, with Turn on and
  alerts. Then the saved copies and waiting replies. The owner didn't object when
  this was proposed, but never chose it in so many words.
- **Tauri 2 for Android,** reusing the Svelte screens.
- **A native core in Rust** in place of the service.
- **A setting that's off by default** for the main PC.
- **The main PC appears under its own machine name,** not "This PC".
- **Installation and updates from the GitHub release.**

## How it works

### The phone's core

A small Rust part of the app takes the local service's place:

- **It listens on loopback** with a random port and a bearer token, like the
  service, and has a `/relay?machine=<id>` endpoint. Relayed frames pass through
  verbatim, so a machine's chat screens don't change at all.
- **It answers the local methods the screens need.** That's more than `hello` and
  the `machines.*` set (pair, list, update, remove, unlock): start-up also calls
  `uiState.*`, `settings.*`, `power.*`, `places.counts`, `sessions.list`,
  `projects.list`, `scheduled.list`, `usage.get` and `search.quick`. Those for chats
  answer empty. It implements the pairing client's proof exchange, so **the code
  is never sent to a machine that can't prove it knows it**, and pins the
  certificate exactly as `machine/pairing-client.ts` does.
- **Tokens** live in a file encrypted with a key from Android's Keystore. The core
  reads them itself, since it has to reconnect after a reboot without the screens.
- **The plug:** the core talks to the Tasmota bridge directly over the home
  network, with the same commands as `power/switch.ts` and the same safety checks as
  `power/hub.ts` (a fresh reading, the minimum off time, one at a time). It never
  calls `power.adopt`, which would overwrite the desktop's copy. The owner types the
  bridge address, plug name and password once per machine on the phone, and the
  password is encrypted like the tokens.

### Staying connected

- An Android **foreground service** with the permanent notification hosts the
  core, so it survives the screens being closed. `specialUse` is the likely
  foreground-service type, since `dataSync` is capped at 6 hours a day on
  Android 15; the builder confirms this. The app asks to be exempted from battery
  optimisation, and explains why.
- The core keeps **its own link to each machine** for alerts, separate from the
  screens' relays. Machines already send `needsYou` and `chatFinished` to every
  device, so they need no change. Those links also receive every chat's streamed
  output and filter it, which costs some battery; the day-long test measures it. A
  link never sends `ui.visibility`, which is global to the machine. After a drop,
  it catches up from `sessions.list`, so what finished meanwhile shows as unread
  rather than as a burst of alerts. An alert names the machine and chat, and
  opening it opens that chat. The webview stops posting alerts on Android.
- **Battery:** an unreachable machine is retried with back-off, up to about a
  minute. Changes of network (Wi-Fi to mobile data, Tailscale coming up) trigger
  an immediate retry. Links ping as the relay does, since a dropped Wi-Fi sends no
  close.
- **Turning it off:** the notification has a Disconnect action, and the app
  doesn't restart it until it's opened again. After a reboot the phone reconnects
  only if it was connected before.

### The screens

- The same SvelteKit UI in the Android webview, with a phone layout: one column
  at a time, going from machines and places to chats to a chat, with a back
  gesture. Tabs become a recent-chats switcher.
- **There's no local machine on the phone,** but the UI keeps its local scope: the
  lists that combine machines live there, and `scopes.local()` is used in 11 files.
  The core answers that scope with empties, and the phone hides its group and never
  offers it in New chat. That keeps the shared UI change small and the desktop
  unchanged. The saved-copy parts stay off in stage one.
- `native.ts` gets an Android side: connection, tokens, plug passwords,
  notifications, an image picker in place of drag and drop, and no tray, autostart or
  desktop updater.
- The CSP stays the same, with `ws://127.0.0.1:*` only. Android needs a network
  security rule allowing cleartext to loopback only.

### The main PC

A new desktop setting, **Let my phone connect**, off by default. When it's on:

- the desktop's service gets a machine certificate and the same TLS listener as a
  headless machine, on private addresses only, with the same pairing, devices and
  revocation. Today both exist only when headless, so this is real work in `main.ts`;
- Settings → Machines shows a pairing code and the devices paired, with Remove;
- the service no longer exits when idle, and the setting offers to start at sign-in.
  **After a reboot the main PC stays out of reach until someone signs in,** and the
  setting says so;
- Windows Firewall probably asks once, and the setting says so.

Turning it off closes the listener and disconnects the phone. The pairings stay
until removed. Local-only methods stay local-only, but a paired phone can do what any
paired device can, including `settings.set` and `work.stopAll` on the main PC; the
docs say so. The desktop's service has no `power.shutdown` and no idle shutdown, and
this design adds neither. Turn on works for any machine whose plug details are on
the phone, so if the main PC later gets a plug, it gets Turn on with nothing more to
build. A clean shutdown of the main PC from the phone stays later work, and the phone
never offers a hard cut in its place.

### Pairing the phone

On the phone: Add machine, then the address and the code from `threadgarden pair`
or the desktop's Settings. No PC needs to be involved beyond showing the code. A
paired device has full control of chats, so the docs must say what losing the
phone means and how to remove it: `threadgarden revoke`, or Settings on the desktop.

### Release and updates

- CI builds a signed APK as part of each release. The signing key is a new one
  that **the owner creates**, and it lives in their password manager and the repo
  secrets. Losing it means reinstalling the app, so the guide says so.
- Tauri's updater doesn't do Android. The app checks the latest release itself,
  shows a notice, and opens the APK download; Android's installer takes it from
  there. The APK is verified by Android against the app's signature.
- The phone speaks the same protocol range rules as the desktop: a machine one
  version either way works, and otherwise it says to update.

## Stage two

Saved copies, waiting replies and delivery, as in
`2026-11-04-away-machine-design.md`, with the phone's core holding them instead of
a local service. It gets its own short design once stage one has shown how well
the connection holds up. Nothing in stage one may make it harder: the core owns
storage from the start, and its `machines.*` and scope shape match the desktop's.

## Testing

- **The UI:** the existing Vitest and Playwright suites must stay green. The
  phone layout gets a Playwright run at a phone viewport against the mock, with a
  mock core that has no local machine.
- **The core:** Rust tests against a real TLS listener. The pin is refused on a
  different certificate, a machine failing the proof never gets the code, relayed
  frames are unchanged, a dead link is noticed, and alerts fire once.
- **The main PC's listener:** service tests that it's closed by default, opens and
  closes with the setting, and keeps local-only methods refused.
- **On the owner's phone:** install, pair kumbal and the main PC, and chat over
  Wi-Fi and mobile data; a question from Claude alerts with the app closed and the
  screen off for an hour; a reboot; Turn on from mobile data; battery use over a day.

## Left to the builder

- The core's exact list of methods, and what each answers.
- The webview's behaviour when Android destroys it while the core lives on.
- Whether the Pi's subnet route reaches the bridge's address, checked in the spike.

A connected device doesn't count towards a machine's idle check (`power/idle.ts`
sees only sessions and external chats), so the phone's links need no special care
there. No test is skipped on that account: the owner's day-long run checks kumbal
still shuts down when idle.

## Risks

- **Android may still kill the background service** on some makers' phones, despite
  the exemption. Only the owner's phone can tell us, so this is tested first.
- **Long Tauri-on-Android unknowns.** The foreground service needs Kotlin alongside
  Rust. An early spike on the owner's phone should prove loopback, the foreground
  service and an alert before the rest is built.
- **Hiding the local scope** touches shared screens, so the desktop's suites must
  stay green.
