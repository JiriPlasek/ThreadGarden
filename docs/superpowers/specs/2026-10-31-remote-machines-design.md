# Remote machines and power control

**Date:** 2026-10-31
**Status:** Design agreed with the owner in conversation on 2026-10-31; §10 and §12 revised with the owner on 2026-11-01 after the power hardware was flashed and measured. Calls marked *(designer's call)* were made without the owner and are listed in §13 for review; *(builder's call)* marks what is left to whoever plans and builds it.
**Builds on:** [v1](2026-10-30-pahub-v1-design.md) through [v1.3](2026-10-31-v1.3-design.md), and the remote-machine notes in [the v1.3 brainstorm](2026-10-31-v1.3-brainstorm.md) §1, which this design supersedes for the remote-machine part. The v1 anti-goals outrank everything here, and the hard rule in CONTRIBUTING.md (Claude Code's data is read-only to Threadgarden) holds for every part.

## 1. Intent

The owner wants a second machine that does Claude Code work for them, so their main PC stays free for gaming, and so that one day they can start work from their phone while away from home.

The second machine is an old PC with a fresh Ubuntu install that sits **headless in a corner**. It is off most of the time. The owner wants to:

- start a new chat on it, in an existing project or in a brand-new one (optionally creating the GitHub repo too), from Threadgarden on the main PC, and later from the phone;
- move a running conversation between machines mid-conversation, by hand, whenever they decide;
- have the machine **turn on by itself** when work is sent to it, and **turn off by itself** once nothing is being worked on for a while (1 hour by default);
- get the work back through GitHub: the remote machine pushes, so the work is reachable from anywhere;
- manage all of it from Threadgarden alone: no second app (not eWeLink, not a router page), and **no cloud**.

## 2. Scope and phases

This is three campaigns. This document designs the first two in full, and the third only far enough that nothing built now blocks it.

1. **Remote machine** (§4–§9): Threadgarden's service runs headless on the Ubuntu PC; the desktop app on the main PC pairs with it, shows its projects and chats, starts and moves chats there.
2. **Power** (§10): the Ubuntu PC is booted and cut through a smart plug on a locally controlled Zigbee bridge; idle shutdown; the push check. Built as plan 4, before campaign 1's plan 3 *(owner, 2026-11-01)*; the parts that need plan 3's local copies come with plan 3.
3. **Phone** (§11, later): the phone reaches the home network through the router's VPN and talks to the machines directly.

Campaign 1 must be usable without campaign 2 (the owner turns the PC on by hand until power control lands).

## 3. Goals, non-goals, anti-goals

**Goals**
- A headless Threadgarden service on Linux that starts at boot and that a desktop Threadgarden can pair with over the home LAN.
- Machines in the UI as layout **A** (§7): every machine is a group in the places column, with its power state and power button.
- New chats and new projects on a remote machine; repos cloned on demand; dependencies installed by Claude inside the chat.
- Manual **Move to…** of a chat between machines, keeping its full history.
- Power on demand through the plug, clean idle shutdown, power cut only after the OS is down.
- An Off machine's projects, chat list and Needs you stay visible on the client, and chats already opened stay readable (§7).
- The headless service is updated from the desktop app, never by hand (§6).

**Non-goals (this release)**
- Automatic handoff or load balancing. A chat moves only when the owner says so.
- Carrying uncommitted files between machines. Code travels through git and GitHub only.
- Browsing or editing the remote machine's files (the code view is a separate deferred feature).
- Pull-request management (separate deferred feature).
- Conflict handling between machines working on the same repo (the owner expects this to be rare).
- Automatic discovery of machines on the network: the owner types an address once *(designer's call)*.
- Any cloud relay, hosted account, or vendor cloud API (eWeLink, Tailscale coordination servers and the like).
- Multiple users. Every paired device belongs to the owner and gets full control.

**Anti-goals** (would make it a failure even if it works)
- Anything goes through a cloud service.
- Power is cut on a machine that is still running.
- Work is lost: a chat, a scheduled message, an answer typed while the machine was off, or commits that never reached GitHub before shutdown.
- Threadgarden writes into `~/.claude` on any machine, in breach of the hard rule.
- The main PC gets slower or noisier for gaming because of this (no heavy polling, no busy loops on the main PC).
- Another device on the LAN can drive the Ubuntu PC without being paired.

## 4. Hardware and environment facts (verified 2026-10-31)

These shaped the design; the builder should not have to rediscover them.

- **Ubuntu PC networking is Wi-Fi** (USB/PCIe Wi-Fi adapter). Wake-on-LAN from full power-off is effectively unavailable over Wi-Fi adapters, so **booting is done by power, not by network**: BIOS "Restore on AC power loss" = **Power On**, and the plug switches AC.
- **Router: TP-Link Archer VX1800v.** It has a built-in OpenVPN server (also PPTP, IPsec); no WireGuard. Used in campaign 3.
- **Plug: SONOFF iPlug S60ZBTPF (Zigbee)**, with power metering (W, V, A, energy) and configurable power-on behaviour. Supported by Zigbee2MQTT and by Tasmota's Zigbee stack.
- **Hub: SONOFF ZB Bridge-P (ZBBridge-P).** With stock firmware it has **no local API**; every command goes through eWeLink's cloud. It is therefore **reflashed with Tasmota** (`tasmota32-zbbrdgpro`, via USB-serial, no soldering; the Zigbee chip is then updated from inside Tasmota). After that it offers a local HTTP command API (`/cm?cmnd=…`, with the Tasmota web password) and can drive and read Zigbee devices (`ZbSend`, `ZbInfo`, power reports). Every Zigbee device on that bridge leaves eWeLink; the owner accepted this.
- **Verified on 2026-11-01 when the owner's hardware was flashed:**
  - **Bridge:** ZBBridge-P, board date code 2530 (ESP32-D0WD-V3, no flash encryption or secure boot).
    - It runs Tasmota 16.0.0 `release-zbbrdgpro`, with Zigbee coordinator firmware 20240710, flashed from inside Tasmota.
    - Tasmota's browser installer wrote an HTML page instead of the firmware; `esptool write-flash` of the factory image worked.
    - Tasmota 16 offered no setup access point, so Wi-Fi was set over the serial line.
    - Its HTTP API refuses requests without a matching `Referer` unless `SetOption128 1` is set.
    - The bridge also serves a second plug (the owner's grow light), scheduled by Timer1, Timer2 and Rule2.
  - **Plug:** the S60ZBTPF switches on `ZbSend … Power`. It reports ActivePower in W (divisor 1), and voltage and current with divisor 100.
    - It does **not** report a power drop on its own, so it must be polled.
    - Its Zigbee short address changed once after pairing, so it is addressed by name.
  - **Ubuntu PC on the plug:**
    - about 47 W idle, ~144 W peak while booting;
    - **0 W** about 20 s after `poweroff` (standby reads as 0);
    - network reachable ~25 s after the plug comes on;
    - BIOS "AC Back" = On needs the AC gone for more than 10 s (90 s proven).
  - **Cut rule tested:** a bridge rule cut the plug 30 s after its reading fell under 5 W.
- **Tools on hand** (from the owner's roborock_mod project): 3.3 V USB-UART adapter (FT232RL/CP2102), Dupont F-F cables, precision screwdriver kit, multimeter, soldering station. Nothing needs buying.
- **GitHub:** the Ubuntu PC is signed in once with the GitHub CLI (`gh auth login`) during setup; Threadgarden never stores GitHub credentials.
- **Claude Code** is installed and signed in on the Ubuntu PC during setup, the same way as on any machine. Each machine uses its own Claude Code authentication.

## 5. Machines

- A **machine** is one Threadgarden service. Each service gets a stable **machine id** (random, generated once, stored in its data dir) and a display name chosen by the owner ("Ubuntu PC"). `hello` returns both, plus the service's capabilities (§6).
- The desktop app always has **This PC** (its own local service, as today) and zero or more **paired machines**. Pairings are stored by the client (address, machine id, name, certificate fingerprint, device token in the OS credential store).
- **Client connects to every machine directly** *(designer's call)*. The main PC's service is not a hub that relays the Ubuntu PC. Reason: in campaign 3 the phone must work while the main PC is off, and the Ubuntu PC must be able to shut itself down without the main PC.
- How the desktop UI holds several connections at once (one `ServiceClient` per machine, state keyed by machine id, merged views for Needs you, Running, the strip and Ctrl/Cmd+K) is *(builder's call)*, within §7.
- Session ids are UUIDs and are unique across machines in practice, but every client-side key that refers to a chat or project includes the machine id *(designer's call)*, so two machines can never collide in the UI.

## 6. Headless service, connection and pairing

**Headless install (Linux, this release).**
- A Linux install that ships the service bundle and its Node runtime without the desktop app, and a **systemd unit** that starts it at boot and restarts it on failure. Packaging form (a `.deb`, a tarball plus install script) is *(builder's call)*; it must be installable over SSH on a fresh Ubuntu.
- In headless mode the service **never exits on idle** (today it exits after 30 minutes with no clients); idleness is handled by §10 instead.
- A small CLI on the headless machine: `threadgarden pair` (prints a pairing code), `threadgarden status`, `threadgarden devices` / `revoke`. Exact command names are *(builder's call)*.
- A setup guide in the docs (§12) walks the owner through the one-time steps.

**Updates from the desktop** *(owner)*. When a connected machine's service is older than the desktop app, the machine's heading and Settings → Machines offer **Update ‹machine›**. The desktop sends the service bundle that ships with it (it ships the Linux headless bundle for this purpose), the machine verifies its integrity (hash, at least) before installing, and restarts the service once no chat on it is mid-turn; live chats become resumable as on any service restart. After the first install the owner never needs SSH for Threadgarden. A machine whose service is newer than the desktop says so and asks the owner to update the desktop. Version skew to support: one protocol version either way *(designer's call)*. How the bundle is transferred and installed (over the protocol, with the systemd unit restarting it) is *(builder's call)*.

**Listening beyond loopback.**
- The service keeps listening on `127.0.0.1` as today. A remote listener is **off by default** and turned on explicitly (in headless mode by the install, elsewhere by a setting "Allow other devices"). It binds to the LAN interface (and, later, the VPN interface), **never to a public interface**.
- The remote listener uses **TLS with a self-signed certificate** generated on first use; clients pin its fingerprint at pairing. No TLS is needed on loopback.
- Before a client sends its device token on a route, it checks that the service at that address presents the pinned certificate and the expected machine id, so an address that now belongs to another device never receives a token.

**Pairing.**
- The headless machine prints a **one-time pairing code** (single use, valid 5 minutes) with `threadgarden pair`. In the desktop app, **Add machine** asks for the address (an IP or a `.local` name; Ubuntu publishes `<hostname>.local` through Avahi) and the code; the service answers with its machine id, name and certificate, and issues a **device token**, revocable from either side.
- Long-lived device tokens never travel in URLs; how the WebSocket authenticates with it (the existing subprotocol scheme, or short-lived tickets) is *(builder's call)*.
- Every paired device has full control (send, answer permissions, stop, move, power) *(designer's call; the owner is the only user)*.

**The webview never talks to the network itself.** The desktop UI's CSP keeps `connect-src` to the loopback service. Remote connections (and plug commands, §10) go through a native or local component that can pin certificates (the Rust shell, or the local service acting as a pinned transport) *(designer's call; which component is the builder's call)*. Reason: the webview cannot pin a self-signed certificate, and widening the CSP would open the UI to the LAN.

**Protocol.** One protocol version bump. `hello` gains machine id, name, platform, capabilities (`headless`, `power`, `remoteProjects`, `move`). New methods (names are *(builder's call)*) cover: machine info and settings, project clone/create, the move export/import (§9), power state and idle settings (§10), pairing and device management. Older clients connecting to a newer service, and the reverse, keep working for everything that existed before.

**Remote paths.** `@` mentions and dropped images refer to files on the machine the chat runs on. `@` suggestions already come from the service, so they are remote-correct; **dropped or pasted images** must be uploaded as bytes to the remote service rather than passed as local paths; dropping a non-image file into a remote chat inserts nothing and says why *(designer's call)*.

## 7. User interface (layout A, chosen by the owner)

- **Places column:** Needs you and Running at the top cover **all machines**. Below them, one **group per machine**: a heading with the machine's name, its **state** and a **⏻ button**, and that machine's projects under it. This PC comes first. Analytics stays below the groups.
- **States:** Off · Starting… · On · Shutting down · Unreachable (the plug reports power but the service does not answer, or the plug is unknown and the service does not answer). Without power control (§10 not configured), a machine is On or Unreachable. Hovering an On machine shows when it will shut down for idleness ("Shuts down in 42 min").
- **⏻ menu:** Turn on · Shut down now (runs the push check, §10) · Keep awake (pauses idle shutdown until turned off, or for a chosen time).
- **Chips:** rows in cross-machine views (Needs you, Running, the agents strip, Ctrl/Cmd+K results) carry a small machine chip; lists inside a machine's group do not.
- **Same project on two machines** is shown twice, once under each machine (they are separate working copies).
- **Chat header** shows the machine and a **Move to…** action (also in the row menu and Ctrl/Cmd+K).
- **New chat dialog** gets a machine picker, defaulting to the machine of the selected project; with a remote machine chosen, the project picker offers that machine's projects plus **"From This PC's projects…"** (clone, §8) and **New project** (§8).
- **A machine that is Off or Unreachable** *(owner)*: its group keeps showing its projects and chat list, and its chats keep their places in Needs you, from a **local copy** the client keeps of each paired machine's lists (refreshed whenever the machine is connected). Chats the owner has opened before stay **readable** from a local copy of their last-seen contents, marked as a copy ("Ubuntu PC is off — showing the last copy"). Opening a chat never boots the machine; sending a message, answering a prompt, or Move to… does. The copy is Threadgarden's own data on the client, never Claude Code's; its size limit and eviction are *(builder's call)*.
- **Starting work on a machine that is off:** the chat opens at once with "Starting Ubuntu PC…"; the first message waits in the chat like a scheduled send and goes out the moment the machine connects. The owner never waits at a spinner.
- **Notifications** from every connected machine are posted by the desktop app as today (Needs you, chat finished, scheduled sent), naming the machine when it is not This PC.
- **Settings:** a Machines section: paired machines (name, address, rename, remove/revoke), per-machine power configuration and **Shut down after idle** (default 1 hour; or never), and on This PC "Allow other devices" for later campaigns.
- **Usage meter:** plan usage is account-wide; the meter shows the most recent reading from any machine *(designer's call)*.
- **Analytics combined across machines** *(owner)*: the Analytics view adds up every paired machine's statistics by default (chats, messages, tokens, active days, per-day series, models, tools, subagent types, the weekday × hour heatmap, title words), with a machine filter next to the project filter. The client asks each connected machine for its `analytics.get` result with the same range and merges them; for a machine that is Off it uses the last result it cached (§7) and says from when. Projects in "busiest projects" carry a machine chip. If a machine has never been reachable since pairing, the view says it is missing from the totals. Merge rules for top-N lists and title words (sum the counts, then cut) are *(builder's call)*; the service's per-machine analytics stay as they are.

## 8. Projects and code on a remote machine

- **Projects folder:** each headless machine keeps cloned and new projects under one folder (default `~/threadgarden/projects/<repo-name>`; configurable) *(designer's call)*. Projects that already have chats on that machine are listed as today, by working directory.
- **Clone from This PC's project:** the client reads the project's git remote (`origin`) and current branch on This PC and asks the remote machine to clone it (or, if it is already there, to fetch and check out that branch, under the working-copy rules below). A project without a GitHub remote cannot be cloned; the dialog says so and offers nothing else *(designer's call)*. Uncommitted local changes do not travel (non-goal).
- **Working copies on a headless machine** *(designer's call)*: Threadgarden owns its projects folder there, so it may clone, fetch and check out freely, with one rule: it never switches the branch under a chat that is live or under uncommitted changes. One clone per repo; when a chat needs a different branch than the one a live chat (or uncommitted work) holds, Threadgarden adds a **git worktree** for that branch next to the clone, which the existing worktree grouping shows under the same repository.
- **Working copies on This PC** *(owner)*: these are the owner's own folders. When a move (§9) brings a chat back to This PC, Threadgarden may fetch and check out the chat's branch in the owner's existing working copy **only if it is clean** (no uncommitted changes, untracked non-ignored files included). If it is not clean, the move stops and says why; Threadgarden never stashes, resets or overwrites anything. A project that exists only on a remote machine (made there with New project) is cloned on This PC into a folder the owner picks once (Settings → Machines, "Where to put projects from other machines") *(owner)*. These are the only git writes Threadgarden makes on This PC; architecture.md's "git access is read-only" note is updated to say so.
- **New project on a remote machine:** name → the machine creates the folder and runs `git init`; with **Create a GitHub repo** ticked, it creates the repo on the owner's account with `gh` (private by default *(designer's call)*) and sets it as `origin`. The chat opens with the owner's first message.
- **Dependencies** (language runtimes, package managers, `pnpm install`, …) are Claude's job inside the chat, as in a terminal. Threadgarden does not detect or install project dependencies itself *(designer's call)*. System-level installs that need `sudo` go through Claude Code's normal permission prompts; whether the setup guide grants the service user passwordless `sudo` for package installs is the owner's choice at setup, documented with its risk.
- **Pushing:** chats on a headless machine get a standing instruction (appended to the system prompt for remote chats) that work counts as done only once it is committed and pushed to the branch the chat is on. Claude pushes to the project's current branch, or to the branch the owner names in the chat; Threadgarden has no branch rules *(owner)*.

## 9. Moving a chat between machines

Owner's intent: no automatic handoff; a manual **Move to…** mid-conversation, in both directions, keeping the conversation so Claude remembers everything.

**Preconditions** (checked before anything moves):
- The chat is not mid-turn (stop it or wait).
- The project on the source machine has no uncommitted changes and no unpushed commits on the chat's branch. Otherwise the move stops and offers **"Ask Claude to commit and push first"** (it sends that request in the chat; the owner may name a WIP branch). Only a clean, pushed project moves *(designer's call, from the "never lose work" rule)*.
- The target machine is On (if it is Off, the move turns it on first and continues when it connects).

**Mechanism: the Agent SDK's session store, never a file copy.** Copying the `.jsonl` would breach the hard rule (Threadgarden never writes under `~/.claude`) and couple Threadgarden to Claude Code's internal transcript format. The SDK (0.3.314) offers an official path:
1. On the source, `importSessionToStore(sessionId, store, { includeSubagents: true })` reads the session through the SDK into a Threadgarden-implemented `SessionStore` (in memory), whose entries are sent to the target over the protocol.
2. On the target, the project is cloned or updated to the same branch under §8's working-copy rules (which may stop the move on This PC), then the chat resumes with `query({ resume: sessionId, sessionStore, cwd: <target working dir> })`. The SDK loads the entries, materialises them to a temporary file and Claude Code resumes from it, writing its own transcript on the target as usual.

These APIs are marked **alpha**. Before building the move, the builder verifies in a throwaway spike that: a session from a Windows `cwd` resumes on Linux with a different `cwd` (which `projectKey` the store must answer for), subagent transcripts come along, tool history renders, and the resumed session appears in `listSessions` on the target. If the spike fails, the **fallback** is a handoff chat: Claude summarises the conversation on the source, the target starts a new chat seeded with that summary, and the new chat links to the old one ("Continued from This PC"); the owner must be told the move is then a summary, not the full history.

**Afterwards:**
- The chat lives on the target. The source keeps its copy as read-only history marked **Moved to ‹machine›**, hidden from the lists so the chat never appears twice; Threadgarden records the move in its own database on both sides (never in Claude Code's data).
- Threadgarden-side metadata (title, bucket, pin, hold, drafts, scheduled sends) moves with the chat.
- Moving back later is the same operation in the other direction.

## 10. Power control

*Revised 2026-11-01 after the owner's hardware was flashed and measured; the facts are in §4. Owner decisions that day:*
- *Power control comes before campaign 1's plan 3, so plan 4 is built first. Its parts that need plan 3's local copies wait for plan 3.*
- *Tasmota is the one supported kind of power switch for now, with an integration smooth enough that the owner could hand Threadgarden to someone else.*
- *Other kinds (Shelly, Home Assistant, Wake-on-LAN) are recorded for later and not built.*

**Power switches.** A machine's power is driven by a **power switch**: a component on the LAN that can switch the machine's AC and read its power draw. Threadgarden's machine logic (states, turning on, idle, the shutdown sequence) talks to a power switch only through one small interface *(designer's call)*. That interface covers switching on and off, reading watts, arming the cut (§10 shutdown, step 4), arming and clearing a wake at a time, and describing the switch for Settings. Other kinds can then be added without touching the machine logic. This campaign builds one kind, **Tasmota**, in two shapes:

1. **A Tasmota Zigbee bridge driving a Zigbee plug with power metering.** This is the owner's setup and is verified on their hardware: ZBBridge-P on Tasmota 16, SONOFF S60ZBTPF.
2. **A Tasmota Wi-Fi plug with power metering**, the plug itself running Tasmota (sold pre-flashed by several makers). Same web API, different commands. It is built and covered by tests against a fake Tasmota, and is labelled *experimental* in Settings and the docs until it has been tried on a real plug *(designer's call)*.

**Talking to Tasmota.** All traffic goes from the native or local component, never from the webview (§6). It uses Tasmota's HTTP command API on the LAN (`/cm?cmnd=…`) with the web password; the user name is always `admin`. Two Tasmota specifics:
- Tasmota 16 refuses API commands from requests without a matching `Referer` unless `SetOption128 1` is set.
- Tasmota offers no TLS, so the password crosses the LAN in the clear. The setup guide says so; the switch is never reachable from outside the LAN. A VPN carries it later (§11).

Threadgarden sends the `Referer` itself, so owners never have to set `SetOption128`. If a device still refuses, Settings says how to fix it *(builder's call how)*. The password is stored in the OS credential store on each client and on the machine's own service, which needs it to arm the cut. It never appears in logs or in the UI after entry.

**Setup in Threadgarden** (Settings → Machines → ‹machine› → **Power**), a short guided flow, so nobody types console commands:
1. **Connect:** the switch's address and web password. Threadgarden reads what the device is: its Tasmota version, and whether it is a Zigbee bridge or a metering plug. It says plainly if the device is not Tasmota, is too old *(builder's call: the oldest version tested)*, or refuses the password.
2. **Choose the plug:**
   - On a bridge, Threadgarden lists the paired Zigbee devices that switch power and measure watts, by their names, each with **live watts**. The owner picks the plug the machine is on; live watts make it obvious which one.
   - On a Wi-Fi plug, this step is skipped.
   - Pairing a new Zigbee plug to the bridge (opening pairing, naming the plug) is also offered here *(designer's call)*, so a fresh setup never needs the Tasmota console.
3. **Check:** the screen shows live watts and the plug's state. The "off" line is a setting, default **5 W**.
   - After the first clean shutdown under Threadgarden, it records the machine's running and shut-down readings and suggests a line between them. The owner can accept or keep the default.
   - The **minimum off time** before switching on again defaults to **90 s** (the owner's PC needs more than 10 s; 90 s is proven) and is a setting.
   - No step switches the plug off as a "test": the machine may be running on it *(designer's call)*.
4. **Save:** Threadgarden installs what it needs on the switch (below) and the machine shows its power state from then on.

**What Threadgarden owns on a shared switch.** A bridge may serve other devices with their own rules and timers. The owner's grow-light plug, scheduled by Timer1, Timer2 and Rule2, is the real case. Threadgarden therefore:
- **Claims one rule slot.** It uses a free one, marks it as Threadgarden's by its content *(builder's call how)*, and refuses with an explanation if none is free.
- **Claims only the timers it needs**, marked the same way.
- **Touches only the plug it was given.**
- **Never** changes other rules, timers, devices, Wi-Fi or firmware. It never opens Zigbee pairing except in setup step 2 at the owner's request, and never removes a device.
- **Reinstalls its rule when it differs** from what this Threadgarden version expects, and removes its rule and timers when the owner turns power control off for that machine.

**State from the plug's power reading.** Off (plug off, or below the "off" line), Starting… (plug on and above the line, service not yet answering), On (service answers), Shutting down, Unreachable (§7). Readings are polled; the S60 does not report a drop on its own, though it accepted the reporting setup. Clients and services poll only while they show or need the state, and never faster than every few seconds. This is not a busy loop on the main PC (§3) *(designer's call)*.

**Turning on.** Plug on → BIOS boots → systemd starts the service → clients connect. If the plug is already on but the reading is below the "off" line, the machine is in standby (for example after a manual `poweroff`). Turning on then **cycles the plug**: off, wait the minimum off time, on. The BIOS only boots on returning AC. The owner's PC answers about 25 s after the plug comes on. A machine that does not answer within a timeout becomes Unreachable *(builder's call: default a few minutes, as old PCs boot slowly)*, and the waiting chats say so.

**Idle.** *(owner)*
- A machine is **busy** while any chat on it is mid-turn.
- Otherwise it is **idle**, including when every chat is finished or waiting on the owner (permission prompt, question, plan approval).
- Open chats on a client do not keep it awake.
- Also busy *(designer's call, same "something is being worked on" test)*:
  - a **background subagent** still running in a chat whose turn has ended;
  - a **Claude Code session Threadgarden did not start** that `claude agents` reports as working. The headless service polls this itself, since no window is open there.
- Background processes left running by a chat (dev servers, watchers) do **not** keep it awake; shutdown ends them *(designer's call)*.
- After **Shut down after idle** (default 1 hour, setting per machine, or never) of continuous idleness, the machine's own service starts the shutdown. Keep awake (§7) pauses this.
- The machine's service runs this timer itself, so it works with every client closed.

**Shutdown sequence** (idle or Shut down now):
1. **Push check** *(designer's call, from "never lose work")*:
   - **What it scans:** every repo and worktree in the machine's projects folder, plus any other working directory with chats on that machine.
   - **What it looks for:** (a) uncommitted changes, including untracked files that are not ignored; (b) local branches with commits that are on no remote branch (ahead of their upstream, or with no upstream at all).
   - **If anything is found, do not shut down.** Put the chat that worked there (or the project) in Needs you as "Unpushed work on ‹machine›", naming what was found, with two actions:
     - **Ask Claude to push it** sends that request in the chat.
     - **Shut down anyway** leaves the work on the machine's disk; nothing is deleted.
     - The idle timer starts again once it is resolved.
   - **Repos with no remote at all** (a New project without a GitHub repo) cannot pass. They are skipped, and their project shows a "Local only" chip instead; their work stays on the disk.
2. End live sessions cleanly (the chats become resumable, as on any service stop).
3. **Arm the power cut** on the switch, then shut the OS down (`systemctl poweroff`). The install grants the service user just that right, for example through a polkit rule or a narrow sudoers entry *(builder's call)*.
4. **The switch cuts power itself**, from Threadgarden's rule. While armed, it reads the plug's power every few seconds (the bridge polls the Zigbee plug). It turns the plug off only once the reading has stayed below the "off" line for a while, about 30 s *(builder's call)*. Rising power cancels the countdown, and it never cuts on a timer alone, so a hung shutdown never gets its power cut *(designer's call)*.
   - If the power never drops, the plug stays on and the next client to connect shows the machine as Unreachable.
   - The arm expires after a while *(builder's call)*, so a forgotten arm can never cut a machine that was started again by hand.
   - **Verified on the owner's hardware:** the PC reads ~47 W idle and **0 W** about 20 s after `poweroff`, and the rule cut the plug 30 s after the first reading under the line.

**Answering while the machine is off** *(needs plan 3's local copies; built with plan 3)*. A message or permission answer for a chat on an Off machine boots it and waits in the chat like a scheduled send, then goes out when the machine connects; Claude resumes from the conversation. A pending permission prompt whose process ended at shutdown is answered by sending the decision as the next message *(builder's call how it is phrased)*. Where that pending message is kept, so it survives the desktop app closing before the machine is up, is *(builder's call)*; it must not be lost (anti-goal). **Until plan 3:** an Off machine's group shows its heading, its state and the ⏻ menu with **Turn on**, plus a line saying its chats appear once it is on. Nothing typed for that machine is accepted while it is off, so nothing can be lost.

**Scheduled sends on a sleeping machine.** Scheduled sends for a remote chat are stored on that machine's service. If one is due later than the idle timeout, the machine still shuts down, and first arms a **wake** on the switch: a Tasmota timer in Threadgarden's slot that turns the plug on a few minutes before the send is due. If the plug is still on in standby at that moment, the wake cycles it as in "Turning on". The send goes out after boot (late sends already fire at the next start, v1.3). This keeps working with every client off *(designer's call)*.

**Manual override.** The owner can still press the PC's power button, or switch the plug from Tasmota's own web page. The plug's power reading keeps the state honest either way.

## 11. Phone (campaign 3, later — constraints only)

- The phone joins the home network through the router's OpenVPN server and connects **directly** to each machine's service and to the bridge, as the desktop does (§5). Nothing in campaigns 1–2 may assume the main PC is on.
- A phone client will need the same pairing (§6) and the same certificate pinning; a QR code at pairing is the natural form there.
- The VPN interface must be bindable as an allowed listen interface (§6).
- Whether the phone client is a native app, a PWA served by a service, or something else is decided in campaign 3.

## 12. Owner setup guide (part of the deliverable)

A doc page, written for the owner, covering in order:
1. **Power switch** (revised 2026-11-01 from the real flash). Two routes, easiest first:
   - **A Tasmota Wi-Fi plug with power metering** (sold pre-flashed): join it to the Wi-Fi with its own setup, set a web password, reserve its address. *Experimental* until tried on a real plug (§10).
   - **A ZB Bridge-P with a Zigbee plug** (for tinkerers or existing Zigbee setups), as done on the owner's hardware:
     1. Back up nothing: the stock firmware is cloud-only.
     2. Open the case. The pads are labelled 3V3, GND, TXD, RXD, GPIO0. Power the bridge from its own USB, not from the adapter: an FT232RL's 3.3 V output is too weak for the bridge's two chips. Wire GND, TXD→RX and RXD→TX to a USB-UART adapter set to **3.3 V logic**. Hold GPIO0 to GND while plugging in power.
     3. Flash `tasmota32-zbbrdgpro.factory.bin` with **esptool `write-flash 0x0`**, after checking it against the release's checksum. Don't use the browser installer: it wrote an HTML page instead of the firmware.
     4. Set the Wi-Fi over the serial console (`Backlog SSID1 …; Password1 …`). Tasmota 16 may offer no setup access point.
     5. Update the Zigbee chip from Tasmota's Berry console with `sonoff_zb_pro_flasher` and the newest `SonoffZBPro_coord_*.hex`.
     6. Set a web password and reserve the bridge's address on the router.
     7. Pairing the plug and everything after it happens in Threadgarden (§10 setup).
2. **Ubuntu PC:**
   - BIOS "Restore on AC power loss" (on ASRock: "AC Back") = **On**. Test it by unplugging for more than 10 s; 90 s is proven.
   - Wi-Fi connected at boot without a login; SSH enabled; a fixed address or `.local` name.
3. **Software on Ubuntu:**
   - Install Claude Code and sign in.
   - Install `git` and `gh`, then `gh auth login --insecure-storage`. With auto-login the GNOME keyring stays locked, and the headless service could not read a keyring token.
   - Install the Threadgarden headless service; `threadgarden pair`. A first headless boot can take a few minutes before the machine shows On.
4. **In Threadgarden:** Add machine, then Power (the guided setup in §10), then a first test chat.

## 13. Calls made without the owner (for review)

Owner answers after the review (2026-10-31): Threadgarden may switch branches in a This PC working copy only if it is clean, and projects from other machines go to a folder the owner picks once (§8); an Off machine keeps its lists and readable copies of opened chats (§7); the headless service is updated from the desktop (§6); Analytics combines all machines (§7). The calls below were made without the owner:

- On a headless machine, one clone per repo plus a worktree when a second branch is needed; never switch a branch under a live chat (§8).
- What the push check covers, its "Shut down anyway" escape, and skipping repos with no remote (§10).
- Background subagents and outside Claude Code sessions count as busy (§10).
- Version skew of one protocol version either way (§6).

- The client connects to every machine directly; the main PC is not a hub (§5).
- The webview never connects off-loopback; remote and plug traffic go through a native/local component that pins certificates (§6).
- TLS with pinned self-signed certificates on the LAN; listening is off by default and never public (§6).
- Every paired device gets full control (§6).
- Manual address entry, no discovery (§3, §6).
- Projects folder `~/threadgarden/projects/<repo>`; clone needs a GitHub remote; new repos private by default (§8).
- Claude installs dependencies; Threadgarden does not (§8).
- A move requires a clean, pushed project and an idle chat; the old copy stays read-only, hidden (§9).
- Background processes do not keep a machine awake (§10).
- Power cut only after the reading shows the PC is off; a plug cycle when it is already on (§10).
- Scheduled sends wake the machine through a bridge timer (§10).
- Power switches sit behind one interface; Tasmota Wi-Fi plugs ship as experimental until tried on real hardware; Threadgarden claims one rule slot and its own timers on a shared switch and touches nothing else; setup never switches the plug off as a test; the cut is armed with an expiry (§10, 2026-11-01).
- The push check blocks shutdown and raises Needs you (§10).
- The usage meter shows the latest reading from any machine (§7). (Analytics is combined across machines: the owner's call after review.)

## 14. Risks to verify early

- **Session-store move** (§9): alpha SDK API; spike first, fallback defined.
- ~~**Tasmota on ZBBridge-P with the S60**~~ — verified 2026-11-01 (§4): on/off, readings (by polling) and a cut rule acting on the reading.
- ~~**BIOS behaviour**~~ — verified 2026-11-01: AC Back = On boots the PC when power returns after more than 10 s.
- **Wi-Fi up at boot without login** on Ubuntu (NetworkManager system connection), so the service is reachable headless.
- **Claude Code sign-in on a headless box** (over SSH) and its token refresh while the box is mostly off.
- **Certificate pinning from the desktop's native side** (Rust or the local service) without widening the webview's CSP.
