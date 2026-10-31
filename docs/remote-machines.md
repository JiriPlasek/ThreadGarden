# Remote machines: run Threadgarden on an Ubuntu PC

This guide sets up a second computer (here: an Ubuntu PC on Wi-Fi, without a
screen) so that Threadgarden on your Windows desktop can run chats on it. You
do the steps once, over SSH; after that everything happens in Threadgarden.

## What it does

- The Ubuntu PC runs the **Threadgarden service headless**: no window, started
  by systemd at boot, never stopping on its own. It runs Claude Code there,
  with that machine's own Claude Code sign-in, history and files.
- Threadgarden on the desktop **pairs** with it once, with a one-time code.
  From then on the Ubuntu PC is a group in the places column, with its
  projects and its state; its chats open in tabs like any other, and Needs
  you, Running, the agents strip, notifications and Ctrl+K include it, each
  row with a machine chip.
- The connection stays on your home network. The Ubuntu PC listens only on
  its private network addresses (port 47380), over TLS, and Threadgarden on
  the desktop pins its certificate when pairing, so a different device that
  later gets the same address is never trusted. Nothing goes through a cloud
  service.
- Every paired device has **full control** of the Ubuntu PC's chats (send,
  answer permissions, stop). Pairing can be revoked from either side.
- Not yet: turning the PC on and off from Threadgarden (power control comes
  in a later release, with the smart plug), cloning or creating projects
  there from Threadgarden, moving chats between machines, and showing a
  machine's chats while it is off. Analytics and the usage meter show This
  PC only for now. Until power control arrives, the Ubuntu PC simply stays
  on.

> **Status of the installer.** `install.sh` has so far only been tested in
> CI (on GitHub's Ubuntu runner, with stand-ins for `systemctl`, `loginctl`
> and `sudo`), never on a real machine. Your first install is its first real
> run: if a step behaves differently from what this guide says, note what it
> printed.

You need: the Ubuntu PC (Ubuntu 22.04 or newer, x64), its Wi-Fi password,
access to your router's admin page, and a Claude subscription or API key
for Claude Code on the Ubuntu PC.

## 1. Prepare the Ubuntu PC

Do this part at the Ubuntu PC with a screen and keyboard attached, or over
SSH once SSH works.

### SSH

```sh
sudo apt update
sudo apt install -y openssh-server
sudo systemctl enable --now ssh
hostname        # the PC's name, e.g. ubuntu-pc
hostname -I     # its current address(es), e.g. 192.168.1.50
```

From Windows (PowerShell; the SSH client is built in):

```powershell
ssh <your-ubuntu-user>@192.168.1.50
```

Every command below runs **on the Ubuntu PC over SSH**, unless it says
Windows.

### Wi-Fi connected at boot, without logging in

A Wi-Fi network set up in Ubuntu's desktop settings may keep its password in
your login keyring, so the PC is only online after someone logs in. Make the
connection a system one that connects for every user at boot:

```sh
nmcli -f NAME,TYPE,AUTOCONNECT connection show
# Use the Wi-Fi connection's NAME from that list in place of "MyWiFi":
sudo nmcli connection modify "MyWiFi" connection.permissions "" connection.autoconnect yes
sudo nmcli connection modify "MyWiFi" 802-11-wireless-security.psk-flags 0 802-11-wireless-security.psk "your-wifi-password"
```

(The password ends up in your shell history; `history -c` clears it.) This
is the NetworkManager setting "All users may connect to this network" with
the password stored for all users. On **Ubuntu Server** without
NetworkManager, the Wi-Fi the installer set up (netplan) already connects at
boot; skip this.

Optionally, stop the PC from going to sleep when idle (Ubuntu Desktop may
suspend after a while):

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Check: `sudo reboot`, do **not** log in at the PC, and connect again from
Windows with `ssh`. If that works, the PC is reachable headless.

### A stable address

Threadgarden reaches the PC at the address you give it when pairing. Make it
stable in one of two ways:

- **A DHCP reservation (recommended):** in your router's admin page, find
  the DHCP settings (on TP-Link routers: Address Reservation) and reserve
  the PC's current address for its Wi-Fi MAC address. The MAC is the
  `link/ether` value of the Wi-Fi device (the one starting with `wl`) in:

  ```sh
  ip link
  ```

- **Its `.local` name:** Ubuntu announces `<hostname>.local` on the network
  (Avahi; on Ubuntu Server install it with `sudo apt install -y avahi-daemon`).
  Check from Windows with `ping ubuntu-pc.local`. If that name does not work
  from Windows, use the reserved IP address instead.

If the address changes anyway, Threadgarden shows the machine as Unreachable
(or "This address answers as a different machine" if another device took
it), and you can change the address in Settings → Machines without pairing
again (see [Troubleshooting](#troubleshooting)).

If you turned on Ubuntu's firewall (`sudo ufw status` says "active"), allow
Threadgarden's port: `sudo ufw allow 47380/tcp`.

## 2. Install the software

### Claude Code

Install it and sign in, as on any machine:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

This puts `claude` in `~/.local/bin`, where the Threadgarden service looks
for it. Log out and in again (or `source ~/.profile`) so `~/.local/bin` is
on your `PATH`, then sign in:

```sh
claude
```

Choose how to sign in. Over SSH no browser opens: Claude Code prints a
link; open it in the browser on Windows, sign in, and paste the code it
shows back into the SSH window. Send a short message to check it answers,
then leave with `/exit`. If chats on the Ubuntu PC later fail because the
sign-in expired, sign in here again the same way.

### git and the GitHub CLI

Claude works on git repositories there, and pushes with your GitHub account:

```sh
sudo apt install -y git gh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
gh auth login
gh auth setup-git
```

In `gh auth login`, choose GitHub.com, HTTPS, and "Login with a web
browser": it prints a one-time code and the address
`https://github.com/login/device`; open that on Windows and enter the code.
Threadgarden itself never stores GitHub credentials.

### The Threadgarden headless service

There are no published releases yet. Every CI run builds the x64 package as
the artifact `threadgarden-headless`: a
`threadgarden-headless-<version>-linux-x64.tar.gz` and its `.sha256`.
Download them into a new, empty folder with the GitHub CLI you just signed
in (replace `<owner>` with the GitHub account the Threadgarden repository
belongs to). Remote machines arrive on `main` when the branch
`feat/remote-machines-1` is merged; until then, take the package from that
branch:

```sh
repo=<owner>/threadgarden
branch=main     # before the merge: branch=feat/remote-machines-1
rm -rf ~/threadgarden-download && mkdir ~/threadgarden-download && cd ~/threadgarden-download
run=$(gh run list --repo "$repo" --workflow ci.yml --branch "$branch" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run download "$run" --repo "$repo" --name threadgarden-headless
ls
```

The latest run is taken whatever its result: the package is built by the
job `check` on Ubuntu, so another job that fails (`rust`, or `bundle` with
its end-to-end tests) marks the run failed but leaves the artifact in place. If
`gh run download` finds no artifact, that run is still in progress or its
Ubuntu `check` job failed: list the runs with
`gh run list --repo "$repo" --workflow ci.yml --branch "$branch"`, or open
the pull request's **Checks** on GitHub (the run id is the number after
`/actions/runs/` in a run's address), then set `run=<id>` and download
again.

Artifacts are kept for **7 days**. When the run you want is older, re-run
it (`gh run rerun "$run" --repo "$repo"`, or **Re-run all jobs** on the
run's page on GitHub) and download once its `check` job has finished.

`gh run list` with `--json` needs a recent GitHub CLI (`gh --version` 2.40 or
newer; Ubuntu 24.04's package is). If Ubuntu's `gh` is older, install it from
GitHub's own package repository as described in
[the GitHub CLI's Linux install guide](https://github.com/cli/cli/blob/trunk/docs/install_linux.md),
or download the artifact on Windows instead: open the CI run on GitHub (as
above: the latest run of the branch, or the run id from the pull request's
checks), download `threadgarden-headless` under Artifacts and unzip it into
a new, empty folder. Empty the download folder on the Ubuntu PC too:

```sh
rm -rf ~/threadgarden-download && mkdir ~/threadgarden-download
```

then copy both files over from PowerShell in the folder you unzipped to
(with your version in the names):

```powershell
scp threadgarden-headless-0.2.0-linux-x64.tar.gz threadgarden-headless-0.2.0-linux-x64.tar.gz.sha256 <your-ubuntu-user>@192.168.1.50:threadgarden-download/
```

For an arm64 PC, build the package yourself from a checkout with
`node scripts/build-headless.mjs --arch arm64`.

Check the download, unpack it and run the installer **as your own user, not
with sudo**:

```sh
cd ~/threadgarden-download
sha256sum -c threadgarden-headless-*-linux-x64.tar.gz.sha256
tar -xzf threadgarden-headless-*-linux-x64.tar.gz
cd threadgarden-headless-*/
./install.sh
```

`sha256sum` must print `OK`; if it does not, download again and do not
install. The installer:

- copies the release to `~/.local/share/threadgarden-headless/<version>`
  (`current` points at it) and links the command `~/.local/bin/threadgarden`;
- installs the systemd **user** unit `threadgarden` (it runs
  `threadgarden serve --headless`);
- explains, then runs once, `sudo loginctl enable-linger <you>`, which lets
  your user's services start at boot and keep running after you log out. It
  may ask for your password. Ctrl+C skips it, but then Threadgarden runs only
  while you are logged in, so accept it;
- enables and starts the service, and prints what to do next.

The service runs with `PATH=~/.local/bin:/usr/local/bin:/usr/bin:/bin`. If
`claude` (or a tool your projects need) lives elsewhere, add it:

```sh
systemctl --user edit threadgarden
```

and put this in the editor that opens (with your own directories), then
restart:

```ini
[Service]
Environment=PATH=/home/<you>/.local/bin:/opt/mytool/bin:/usr/local/bin:/usr/bin:/bin
```

```sh
systemctl --user restart threadgarden
```

Check that it runs and listens:

```sh
threadgarden status
```

It should say `Threadgarden <version> is running (protocol 5, headless).` and
`Listening for devices on 192.168.1.50:47380`. Optionally give the machine
the name Threadgarden should show (the host name until you do):

```sh
threadgarden rename "Ubuntu PC"
```

## 3. Pair it with Threadgarden on Windows

On the Ubuntu PC:

```sh
threadgarden pair
```

```text
Pairing code: ABCD-EFGH-JKMN (valid for 5 minutes)
Address: 172.17.0.1
Address: 192.168.1.50
Port: 47380
Name: Ubuntu PC
```

It lists every private address the PC listens on, one per line: besides
the Wi-Fi's there can be others (here `172.17.0.1`, Docker's). The code
works once, for 5 minutes; running `threadgarden pair` again replaces it. Then, in Threadgarden on Windows:

1. Open **Settings** (the gear at the top of the places column) and scroll to
   **Machines**. Click **Add machine…**.
2. **Address:** the address you reach the PC at: the one you use for
   `ssh` (`192.168.1.50`; `hostname -I` lists them), or `ubuntu-pc.local`.
   If `Port:` is not 47380, open **More** and enter it (or type
   `192.168.1.50:47390` in Address; Threadgarden splits it).
3. **Pairing code:** the code (dashes and case do not matter).
4. **This device's name:** how the Ubuntu PC will list your desktop
   (`threadgarden devices`); it starts as this PC's name.
5. Click **Pair**.

Threadgarden first checks that the machine at that address knows the code
(the code is not sent until it does), then pairs. The dialog closes, the
machine is listed in Settings → Machines as **On**, and the places column
shows a group for it under This PC.

**A first chat there:** click **New chat** (the + beside the tabs, or
Ctrl+N), choose the machine under
**Machine**, and pick its **Home folder** (or one of its projects). Ask, for
example, "Clone `<owner>/<repo>` with gh into `~/projects`". Until
Threadgarden can clone and create projects itself (a later release), a
folder on the Ubuntu PC becomes a project there once a chat has run in it:
the simplest way is to clone it over SSH and run `claude` in it once
(`cd ~/projects/<repo> && claude`, one message, `/exit`).

## Troubleshooting

### By the state Threadgarden shows

The machine's heading in the places column and its entry in Settings →
Machines show its state. **Needs attention** comes with a reason, shown
under the heading's **Open settings** and in Settings → Machines.

| State or reason | What it means | What to do |
| --- | --- | --- |
| **Connecting…** | Threadgarden is connecting. | Wait a few seconds. |
| **Unreachable** | No answer at the address. Threadgarden keeps retrying. | Check that the PC is on and on the network (`ping 192.168.1.50` or `ssh` from Windows), then that the service runs (`systemctl --user status threadgarden`, `threadgarden status`). If the PC's address changed, enter the new one in Settings → Machines and click **Save ‹name›**: the pairing stays. |
| **Needs attention:** This address answers as a different machine | Something answers at the address, but not with the certificate that was paired. Nothing was sent to it. | Usually the address now belongs to another device (DHCP): find the PC's address (`hostname -I`) and change it in Settings → Machines. If the Ubuntu PC's Threadgarden data was reset (or its TLS identity was replaced; its log says "created a new one — paired devices must pair again"), **Remove** the machine and pair again. |
| **Needs attention:** This device was removed on ‹name› | The Ubuntu PC revoked this desktop (`threadgarden revoke`). | **Remove** it in Settings → Machines, then `threadgarden pair` and **Add machine…** again. |
| **Needs attention:** Pair again | This PC no longer has the machine's device token (for example the Windows credential store entry was deleted). | **Remove** it, then pair again. |
| **Needs attention:** Different Threadgarden version | The two versions are too far apart (more than one protocol version). | Install the matching release on the Ubuntu PC (see [Upgrading](#upgrading)) or update the desktop app. |

### When pairing fails

| Message in Add machine | What to do |
| --- | --- |
| Can't reach ‹address›. Is the machine on and Threadgarden running there? | Check the address and the port (under More), and on the PC `threadgarden status` (it must say it is listening, on that address). |
| The machine at ‹address› couldn't prove it knows this code. Nothing was sent. | A typo in the code, a newer `threadgarden pair` replaced it, or the address belongs to another device. Check both. |
| That code isn't valid. / That code has expired. | Run `threadgarden pair` again and use the new code. The PC accepts pairing only while a code is live (5 minutes, one use); five wrong tries also invalidate it. |
| That's this machine. | The address is your desktop's own. |
| Already paired as ‹name›. | It is paired already; see Settings → Machines. |

### On the Ubuntu PC

```sh
threadgarden status                     # running? where does it listen? how many devices?
threadgarden devices                    # paired devices: id, name, when paired, last seen
threadgarden revoke <device-id>         # unpair one; it is disconnected at once
systemctl --user status threadgarden    # the systemd unit
systemctl --user restart threadgarden   # restart it (running chats become resumable)
journalctl --user -u threadgarden -e    # why it failed to start or crashed
tail -n 50 ~/.local/share/threadgarden/logs/service.log   # the service's own log
```

- `threadgarden: command not found`: `~/.local/bin` is not on your `PATH`
  yet; log out and in again, or run `~/.local/bin/threadgarden`.
- `Threadgarden is not running.`: start it with
  `systemctl --user start threadgarden` and look at `journalctl` above if it
  stops again.
- `Not listening for devices.` (from `threadgarden status`) or
  `Not listening for devices: no private network address yet.` (from
  `threadgarden pair`): the PC has no private network address right now
  (Wi-Fi not connected). The service checks again every minute and starts
  listening when one appears; its log
  (`~/.local/share/threadgarden/logs/service.log`) then says "listening for
  devices on …".
- The service does not run after a reboot until you log in: lingering is
  off. Run `sudo loginctl enable-linger $USER`.
- Chats on the PC say Claude Code is missing: `claude` is not on the
  service's `PATH` (see the `systemctl --user edit` step above).

## Upgrading

Download the new release as in [the install step](#the-threadgarden-headless-service)
(a fresh, empty folder), check it with `sha256sum -c`, unpack it, and run its
`./install.sh`. It installs the new version next to the old one, points
`current` at it and restarts the service; running chats become resumable,
as after any restart. The previous version is kept (older ones are removed),
so going back is one command:

```sh
ls ~/.local/share/threadgarden-headless/
~/.local/share/threadgarden-headless/<previous-version>/install.sh
```

The desktop accepts a machine whose service is one protocol version older
or newer than its own.

## Uninstalling

In Threadgarden on Windows, **Remove** the machine in Settings → Machines
(it also asks the Ubuntu PC to forget this desktop). Then on the Ubuntu PC:

```sh
systemctl --user disable --now threadgarden
rm -f ~/.config/systemd/user/threadgarden.service
rm -rf ~/.config/systemd/user/threadgarden.service.d
systemctl --user daemon-reload
rm -f ~/.local/bin/threadgarden
rm -rf ~/.local/share/threadgarden-headless
```

That removes the program. Threadgarden's own data on the PC (its database
with the paired devices, its certificate and its logs) stays in
`~/.local/share/threadgarden`; delete it too with
`rm -rf ~/.local/share/threadgarden`. Claude Code and its history
(`~/.claude`) are not touched. If nothing else needs lingering:
`sudo loginctl disable-linger $USER`.
