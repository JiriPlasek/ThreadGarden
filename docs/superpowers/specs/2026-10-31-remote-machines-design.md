# Remote machines and power control

**Date:** 2026-10-31
**Status:** Design agreed with the owner in conversation on 2026-10-31. Calls marked *(designer's call)* were made without the owner and are listed in §13 for review; *(builder's call)* marks what is left to whoever plans and builds it.
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
2. **Power** (§10): the Ubuntu PC is booted and cut through a smart plug on a locally controlled Zigbee bridge; idle shutdown; the push check.
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

**Components.** The Tasmota-flashed ZB Bridge-P (local HTTP API on the LAN, always on) and the S60 plug on it; the Ubuntu PC's BIOS set to Power On after AC loss. Configured per machine in Settings → Machines: bridge address, Tasmota password, which Zigbee device is the plug, and the power thresholds (below). The configuration is stored on the client and also pushed to the machine's own service, because the machine needs it to cut its own power *(designer's call)*.

**State from the plug's power reading.** Off (plug off, or near-zero watts), Starting… (watts up, service not yet answering), On (service answers), Shutting down, Unreachable (§7). Thresholds (e.g. "off" below a few watts) are set per machine with sensible defaults *(builder's call; the owner's PC has not been measured)*.

**Turning on.** Plug on → BIOS boots → systemd starts the service → clients connect. If the plug is already on but the PC is off (e.g. after a manual OS shutdown with the plug left on), turning on cycles the plug off and on, since the BIOS only boots on returning AC *(designer's call)*. A machine that does not answer within a timeout (builder's call; old PCs boot slowly) becomes Unreachable and the waiting chats say so.

**Idle.** *(owner)* A machine is **busy** while any chat on it is mid-turn; otherwise it is **idle** — including when every chat is finished or waiting on the owner (permission prompt, question, plan approval). Open chats on a client do not keep it awake. Also busy *(designer's call, same "something is being worked on" test)*: a **background subagent** still running in a chat whose turn has ended, and a **Claude Code session Threadgarden did not start** that `claude agents` reports as working (the headless service polls it itself, since no window is open there). Background processes left running by a chat (dev servers, watchers) do **not** keep it awake; shutdown ends them *(designer's call)*. After **Shut down after idle** (default 1 hour, setting per machine, or never) of continuous idleness the machine's own service starts the shutdown. Keep awake (§7) pauses this. The machine's service runs this timer itself, so it works with every client closed.

**Shutdown sequence** (idle or Shut down now):
1. **Push check** *(designer's call, from "never lose work")*: over every repo and worktree in the machine's projects folder plus any other working directory with chats on that machine, look for (a) uncommitted changes, including untracked files that are not ignored, and (b) local branches with commits that are on no remote branch (ahead of their upstream, or with no upstream at all). If any are found, **do not shut down**: put the chat that worked there (or the project) in Needs you as "Unpushed work on ‹machine›", naming what was found, with two actions: **Ask Claude to push it** (sends that request in the chat) and **Shut down anyway** (the work stays on the machine's disk; nothing is deleted). The idle timer starts again once it is resolved. Repos **with no remote at all** (a New project without a GitHub repo) cannot pass, so they are skipped and their project shows a "Local only" chip instead; their work stays on the disk.
2. End live sessions cleanly (the chats become resumable, as on any service stop).
3. Arm the **power cut** on the bridge, then shut the OS down (`systemctl poweroff`; the install grants the service user just that right, e.g. through a polkit rule or a narrow sudoers entry — *(builder's call)*).
4. The bridge turns the plug off only once the plug's power has stayed below the "off" threshold for a while (a Tasmota rule or timer armed in step 3), and never on a timer alone, so a hung shutdown never gets its power cut *(designer's call)*. If the power never drops, the plug stays on and the next client to connect shows the machine as Unreachable.

**Answering while the machine is off.** A message or permission answer for a chat on an Off machine boots it and waits in the chat like a scheduled send, then goes out when the machine connects; Claude resumes from the conversation. A pending permission prompt whose process ended at shutdown is answered by sending the decision as the next message *(builder's call how it is phrased)*. Where that pending message is kept so it survives the desktop app closing before the machine is up is *(builder's call)*; it must not be lost (anti-goal).

**Scheduled sends on a sleeping machine.** Scheduled sends for a remote chat are stored on that machine's service. If one is due later than the idle timeout, the machine still shuts down, and before shutting down arms a **Tasmota timer** on the bridge that turns the plug on a few minutes before the send is due; the send goes out after boot (late sends already fire at the next start, v1.3). This keeps working with every client off *(designer's call)*.

**Manual override.** The owner can still press the PC's power button. The plug's power reading keeps the state honest either way.

## 11. Phone (campaign 3, later — constraints only)

- The phone joins the home network through the router's OpenVPN server and connects **directly** to each machine's service and to the bridge, as the desktop does (§5). Nothing in campaigns 1–2 may assume the main PC is on.
- A phone client will need the same pairing (§6) and the same certificate pinning; a QR code at pairing is the natural form there.
- The VPN interface must be bindable as an allowed listen interface (§6).
- Whether the phone client is a native app, a PWA served by a service, or something else is decided in campaign 3.

## 12. Owner setup guide (part of the deliverable)

A doc page, written for the owner, covering in order:
1. **Bridge:** back up nothing (stock firmware is cloud-only), open the ZB Bridge-P, connect the 3.3 V USB-UART adapter (never 5 V), flash `tasmota32-zbbrdgpro` with the Tasmota web installer, update the Zigbee chip from Tasmota, set a web password, give it a fixed address (DHCP reservation on the router), pair the S60 plug, check `ZbSend` on/off and power reports.
2. **Ubuntu PC:** BIOS "Restore on AC power loss" = Power On; Wi-Fi connected at boot without a login; SSH enabled; a fixed address or `.local` name.
3. **Software on Ubuntu:** install Claude Code and sign in; install `git` and `gh`, `gh auth login`; install the Threadgarden headless service; `threadgarden pair`.
4. **In Threadgarden:** Add machine, then the power configuration, then a first test chat.

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
- The push check blocks shutdown and raises Needs you (§10).
- The usage meter shows the latest reading from any machine (§7). (Analytics is combined across machines: the owner's call after review.)

## 14. Risks to verify early

- **Session-store move** (§9): alpha SDK API; spike first, fallback defined.
- **Tasmota on ZBBridge-P with the S60:** on/off, power reports and rules/timers that can act on a Zigbee device's power reading; verify on the owner's hardware before building §10's cut logic.
- **BIOS behaviour** of the owner's old PC (Restore on AC power loss present and reliable).
- **Wi-Fi up at boot without login** on Ubuntu (NetworkManager system connection), so the service is reachable headless.
- **Claude Code sign-in on a headless box** (over SSH) and its token refresh while the box is mostly off.
- **Certificate pinning from the desktop's native side** (Rust or the local service) without widening the webview's CSP.
