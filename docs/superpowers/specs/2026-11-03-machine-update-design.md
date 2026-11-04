# Update a machine from the desktop: design

Date: 2026-11-03. Status: agreed with the owner in brainstorming; awaiting their read of this document.

## Why

The Ubuntu PC (`kumbal-machine`) runs the headless Threadgarden service. Today every release means the owner opens SSH and pastes:
1. download `threadgarden-headless-linux-x64.tar.gz` and its `.sha256` from the latest GitHub release;
2. `sha256sum -c`;
3. `tar -xzf`;
4. `./install.sh` as their own user.

The desktop updates itself, but the machine doesn't. The owner also can't see which version a machine runs anywhere in the app ("now I cant see it anywhere").

**Success:** after a release, the owner opens Settings, sees that kumbal is behind, clicks one button, and a minute later it runs the new version. No SSH.

## Goals (owner)

1. **Versions in Settings → Machines:** This PC's version, and each paired machine's version.
2. **An Update button** on a machine's card in Settings → Machines, when that machine is older than the latest release.
3. **A quiet notice:** a small dot on the Settings button while any machine is older than the latest release, and nothing louder (no Needs you entry, no chip in the places column). The owner chose the minimal option.
4. **Prompt before interrupting.** If any chat on that machine is mid-turn (or otherwise busy, below), the owner is asked first. Updating restarts the service and stops those turns; they can confirm or cancel.
5. **An Off machine is started, then updated.** If it has power control, Update turns it on, waits until it is On, then updates. The normal idle shutdown turns it off again later. There's no special "turn off after updating".
6. **Always the latest release.** "Update to latest, dont complicate it." The target is the newest published release, not the desktop's own version.

## Non-goals

- Automatic updates without a click.
- Choosing a version, downgrading, or picking a pre-release.
- Updating This PC's service; the desktop's own self-update covers it.
- Updating machines that run a version without this feature. The first update to a version with it is the last one done over SSH.
- Plan 3 (an Off machine's chats, queued messages). That is the next design, separate from this one.

## Anti-goals

- **A half-installed machine that never comes back.** A failed update must leave a working service, the old one or the new one, reachable from the desktop. On a headless box nobody is at the screen.
- **A loud UI.** No banners, popups or Needs you entries for "update available".
- **Prompts on the machine.** The update must never wait on a terminal: no sudo password prompt, no interactive question.

## What the owner sees

**Settings → Machines**
- The "This PC" line shows `Threadgarden <appVersion>`.
- Each machine's card shows its version next to its state, e.g. `Threadgarden 0.7.0`.
  - When a newer release exists, it adds `· 0.7.1 available` and the button **Update to 0.7.1**, next to Save and Remove.
  - For an Off machine, the version shown is the last version Threadgarden saw (my call: remember it per machine). An Off machine with power control can still be updated (goal 5). One without power control shows the button disabled, with "Turn it on to update".
- **While updating,** the card shows the stage:
  - Turning on… (only if it was off);
  - Downloading 0.7.1…;
  - Installing…;
  - Restarting…;
  - then `Threadgarden 0.7.1 ✓`.
  The owner can close Settings meanwhile; the update goes on.
- **On failure,** the card shows a one-line reason (e.g. "The download's checksum didn't match", "0.7.1 didn't start; kumbal-machine is back on 0.7.0"), and the button stays to try again.

**The prompt (goal 4).** It uses the machine's existing busy notion, the one idle shutdown and Move to… use. That covers chats mid-turn, waiting on a permission or question, background agents, and a Threadgarden chat running in a terminal. If any are busy:

> **Update kumbal-machine now?**
> Claude is working in 2 chats on kumbal-machine. Updating restarts Threadgarden there and stops them.
> [Update anyway] [Cancel]

The wording is the builder's within that meaning. With nothing busy, there's no prompt.

**The dot (goal 3):** a small dot on the Settings button (or its icon) whenever at least one paired machine is older than the latest release. It goes away when none are. My call: no dot for a machine that can't be updated from the desktop (too old for this feature). Instead its card says "Update it over SSH this once" with a link to the guide's Upgrading section.

## How it works (decided)

**Knowing the latest release**
- The latest version comes from the release's `latest.json`, at `https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/latest.json`. The desktop's updater already reads that file.
- The desktop's own updater only reports a version newer than the desktop. When the desktop is up to date, the latest version must still be known some other way. The builder picks it: the desktop's native side reads `latest.json` itself, or the machine checks.
- Checks run on the same cadence as the desktop's update check, and on opening Settings. They are never faster.

**Knowing a machine's version:** the remote service already returns `serviceVersion` in `hello`. Show it, and remember the last value per machine for when it is Off.

**Doing the update on the machine:** the service does what the owner does by hand today, as a new remote method. The new protocol version brings a capability, e.g. `update`, the same pattern as `move`.
1. Download the versioned assets `threadgarden-headless-<version>-linux-x64.tar.gz` and `.sha256` from that release, into a fresh temporary folder under Threadgarden's own data dir.
2. Check the sha256. On a mismatch, stop, delete the download, and report it.
3. Unpack it, and check that its `VERSION` file says the expected version.
4. **Run the new `install.sh` outside the service's own process group,** so the `systemctl --user restart threadgarden` at its end doesn't kill the update midway. Use e.g. `systemd-run --user` with a transient unit. Run it with `SUDO="sudo -n"`: lingering and the polkit rule are normally already in place, and if not, the script must fail that step rather than wait for a password (anti-goal).
5. **Watch that the new version comes up.** The transient unit (or a small step after install) waits for the service to answer with the new version. If it isn't running within a timeout (builder's choice, around 60–90 s):
   - point `current` back at the previous version, which `install.sh` already keeps, and restart;
   - the desktop then reports "0.7.1 didn't start; kumbal-machine is back on 0.7.0".
   - The detail goes to the service log.
6. Delete the download folder afterwards. `install.sh` already prunes old releases.

**The desktop's side:** reconnecting during the restart is normal. The card follows the stages from the service while connected, then waits for the machine to reconnect and checks its new `serviceVersion`.

**Compatibility across versions:** the update must keep working from any later desktop to any machine that has this feature, even when they are far enough apart that today the desktop shows "Different Threadgarden version" and refuses to use the machine.
- The update method and its result must stay readable across protocol versions: keep it small and never change it incompatibly.
- The desktop must be able to call it on a machine that is otherwise outside its protocol range.
- Otherwise a machine left behind for two releases could never be updated from the desktop again.

**Trust:** the sha256 file comes from the same GitHub release as the package, the same trust as the manual steps today. It catches a broken download, not a compromised release.
- Fetches go over HTTPS only. They start at `github.com` and follow redirects only to GitHub's own download hosts (`*.githubusercontent.com`) (my call: release downloads redirect there).
- The method is available only to paired devices, as every remote method is.

**A sudo step skipped during an update (my call):** the update still counts as done, with a quiet note on the card. This happens when lingering or the polkit power-off rule is missing, or the rule's text changed in the new release, so `sudo -n` can't write it.
- Example: "Updated. Idle shutdown can't power kumbal-machine off until you run `~/.local/share/threadgarden-headless/current/install.sh` once over SSH."
- `install.sh` must report a skipped step in a form the service can read (an exit code or a marker file, the builder's choice), so it isn't lost in output nobody reads.
- It's not a rollback: the new version runs fine.

**A desktop behind the release (my call: no hold-back).** If This PC hasn't updated itself and the latest release is more than one protocol version ahead of it, updating a machine can leave that machine outside This PC's range ("Different Threadgarden version"), and likewise for another paired desktop.
- Nothing blocks the update: "update to latest, dont complicate it". Updating the desktop fixes it.
- The one cheap guard: while This PC itself has an update available, the Update prompt adds a line, "This PC has an update too; install it as well so they keep talking." That way the owner sees it before clicking.

**Rust copy of the protocol version:** bump it with the protocol, as every protocol bump did (`apps/desktop/src-tauri/src/service.rs`).

## Left to the builder

- Where the latest-version check lives (desktop native side or the service), its caching, and how the stages are reported (events or polling).
- The exact transient-unit and rollback mechanics, and the timeout.
- Wording, within the meanings above.
- How a mock machine in e2e simulates an update; the e2e should cover the button, the prompt, the stages and a failure.
- Docs:
  - `docs/remote-machines.md` → "Upgrading": update from Settings, plus the manual way for older machines or when the update fails;
  - `docs/architecture.md`;
  - `CONTRIBUTING.md` if it lists methods.

## Facts the builder should know

- `packaging/headless/install.sh`:
  - copies the release to `~/.local/share/threadgarden-headless/<version>`, points `current` at it, and keeps the previous release;
  - prompts with sudo for `loginctl enable-linger` and a polkit rule only when they are missing;
  - ends with `systemctl --user restart threadgarden`.
- The unit is `packaging/headless/threadgarden.service`: `Restart=on-failure`; ExecStart is `current/bin/threadgarden serve --headless`.
- Release assets: both the unversioned (`threadgarden-headless-linux-x64.tar.gz`) and the versioned (`threadgarden-headless-<version>-linux-x64.tar.gz`) names exist, each with `.sha256`, plus `SHA256SUMS` and `latest.json`.
- The machine's busy notion (turn, prompt, subagents, terminal) exists for idle shutdown and Move to….
- Power control's Turn on, and its wait until On, exist (Move to… uses them for an Off target).
