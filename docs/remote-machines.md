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
- Optionally, Threadgarden turns the PC on and shuts it down through a
  Tasmota smart plug on your network: see [Power control](#4-power-control).
  Without it the PC simply stays on.
- Not yet: cloning or creating projects there from Threadgarden, moving
  chats between machines, and showing a machine's chats while it is off
  (an Off machine's group says "Its chats appear once it's on."). Analytics
  and the usage meter show This PC only for now.

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
Windows with `ssh`. If that works, the PC is reachable headless. A first
headless boot can take a few minutes, so give it time before you decide it
failed.

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
gh auth login --insecure-storage
gh auth setup-git
```

In `gh auth login`, choose GitHub.com, HTTPS, and "Login with a web
browser": it prints a one-time code and the address
`https://github.com/login/device`; open that on Windows and enter the code.
`--insecure-storage` keeps the token in `gh`'s config file instead of the
desktop keyring: on a PC that logs in without a password the keyring stays
locked, and the headless service could not read a token kept there.
Threadgarden itself never stores GitHub credentials.

### The Threadgarden headless service

Download the latest release's package and its checksum into a new, empty
folder:

```sh
rm -rf ~/threadgarden-download && mkdir ~/threadgarden-download && cd ~/threadgarden-download
base=https://github.com/JiriPlasek/ThreadGarden/releases/latest/download
curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz"
curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz.sha256"
```

The same two files are on the
[Releases page](https://github.com/JiriPlasek/ThreadGarden/releases/latest),
if you would rather download them on Windows and copy them over with `scp`.

To try an unreleased branch instead, take the `threadgarden-headless`
artifact of its latest CI run (`gh run download <run-id> --repo
JiriPlasek/ThreadGarden --name threadgarden-headless`; artifacts are kept 7
days) and use its versioned file names below. For an arm64 PC, build the
package yourself from a checkout with `pnpm build:headless -- --arch arm64`.

Check the download, unpack it and run the installer **as your own user, not
with sudo**:

```sh
cd ~/threadgarden-download
sha256sum -c threadgarden-headless-linux-x64.tar.gz.sha256
tar -xzf threadgarden-headless-linux-x64.tar.gz
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
- offers to write `/etc/polkit-1/rules.d/49-threadgarden-power.rules` with
  `sudo`, which lets your user power the machine off from the service (idle
  shutdown and Shut down now). Ctrl+C skips it; do that if you will not use
  power control, everything else works without it. If the installer warns
  that there is "no polkit rules directory", the system is too old for the
  rule: idle shutdown cannot power the machine off there, and everything else
  works;
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

It should say `Threadgarden <version> is running (protocol 6, headless).` and
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

## 4. Power control

Optional. With a Tasmota smart plug that measures power, Threadgarden turns the
Ubuntu PC on (by switching its power), shuts it down when it has been idle, and
wakes it for a scheduled message. It all goes over your home network, from the
Threadgarden services to the switch; the desktop's window never talks to it.
The plug powers the PC, so the PC has to boot by itself whenever power returns
(4.3).

### 4.1 Choose a switch

- **A ZB Bridge-P with a Zigbee plug**: a SONOFF ZBBridge-P running Tasmota,
  and a Zigbee plug that reports watts, such as the SONOFF S60ZBTPF. This is
  the route that has been tried on real hardware. The bridge can keep serving
  other Zigbee devices; Threadgarden leaves them alone (4.5). Prepare it as in
  4.2.
- **A Tasmota Wi-Fi plug with power metering**, several makers sell them
  pre-flashed. Join it to your Wi-Fi with its own setup page, set a web
  password and reserve its address on the router (as in 4.2, steps 5 and 6).
  This route is **Experimental**: it is covered by tests against a fake
  Tasmota but has not been tried on a real plug.

### 4.2 Prepare a ZB Bridge-P

The stock firmware only works through eWeLink's cloud, so the bridge is
reflashed with Tasmota; every Zigbee device on it then leaves eWeLink. You need
a USB-UART adapter (FT232RL or CP2102), a few Dupont cables, a small
screwdriver, and Python on your PC with `python -m pip install esptool`.
Download `tasmota32-zbbrdgpro.factory.bin` from the
[Tasmota releases](https://github.com/arendst/Tasmota/releases) and check it
against the checksum on the release page (in PowerShell:
`Get-FileHash -Algorithm SHA256 tasmota32-zbbrdgpro.factory.bin`). This route
was done on a board with date code 2530 (ESP32-D0WD-V3, no flash encryption or
secure boot); a different board revision may differ.

1. **Open the case.** The board's pads are labelled 3V3, GND, TXD, RXD and
   GPIO0. Power the bridge from **its own USB port**, not from the adapter: an
   FT232RL's 3.3 V output is too weak for the bridge's two chips. Check the
   adapter's jumper or switch is on **3.3 V** logic, never 5 V: the ESP32
   does not tolerate 5 V. Connect only GND, the bridge's TXD to the adapter's
   RX, its RXD to the adapter's TX, and GPIO0 to GND while you plug the power
   in (then release it); leave the 3V3 pad unconnected.
2. **Flash Tasmota.** Use esptool, not the browser installer (it wrote an HTML
   page instead of the firmware). Replace `COM5` with the adapter's port:

   ```powershell
   python -m esptool --port COM5 --baud 460800 --before no-reset --after no-reset write-flash --erase-all 0x0 tasmota32-zbbrdgpro.factory.bin
   ```

   `--erase-all` wipes the stock firmware for good, and there is no way back
   to eWeLink's cloud-only firmware from this guide. Then unplug the bridge's
   power and plug it in again, without GPIO0 held.
3. **Join your Wi-Fi over the serial line.** Tasmota 16 may offer no setup
   access point. Open the adapter's port in a serial terminal and enter:

   ```text
   Backlog SSID1 your-wifi-name; Password1 your-wifi-password
   ```

   The bridge restarts and joins; its address is printed on the serial line
   (or look it up in your router). Open `http://<address>/` in a browser to
   check.
4. **Update the Zigbee chip.** Download the newest `SonoffZBPro_coord_*.hex`
   from
   [Tasmota's Zigbee bridge firmware folder](https://github.com/arendst/Tasmota/tree/development/tools/fw_SonoffZigbeeBridgePro_cc2652)
   (this guide was verified with `SonoffZBPro_coord_20240710.hex`) and upload
   it to the bridge's file system (its web page, Consoles → Manage File
   System). Then open Consoles → Berry Scripting console, and run, one line at
   a time:

   ```berry
   import sonoff_zb_pro_flasher as cc
   cc.load("SonoffZBPro_coord_20240710.hex")
   cc.check()
   cc.flash()
   ```

   Use your file's name in `cc.load`. `cc.check()` must print **Verification
   of HEX file OK**; if it does not, do not flash. `cc.flash()` takes about 10
   minutes: keep the bridge powered and do not interrupt it, since an
   interrupted flash can leave the Zigbee chip unusable. It ends with
   **Flashing completed: OK**. Then restart the bridge and check that its
   console says **Started as coordinator**.
5. **Set a web password** (Configuration → Configure Other → Web Admin
   Password). Threadgarden signs in as `admin` with it.
6. **Reserve the bridge's address** in your router (a DHCP reservation, as for
   the Ubuntu PC), so Threadgarden finds it again.

Pairing the plug to the bridge happens in Threadgarden (4.4).

### 4.3 The BIOS

Switching power only boots the PC if its firmware starts it when power
returns. In the BIOS, set **Restore on AC power loss** (ASRock calls it **AC
Back**) to **On**. Test it: shut the PC down, unplug it for **more than 10
seconds** (a shorter cut may leave it off), plug it in, and it must start by
itself. Threadgarden's default wait before switching on again is 90 seconds,
which is proven to work.

### 4.4 In Threadgarden

Plug the Ubuntu PC into the smart plug, turn it on, and make sure the machine
shows On. Then, in Settings → Machines → the machine → **Power**, click **Set
up power control…**:

1. **Connect.** Enter the switch's address and its web password (the user name
   is always `admin`). Threadgarden checks what the device is and says plainly
   if it is not Tasmota or refuses the password.
2. **Choose the plug** (a Zigbee bridge only). The list shows the paired plugs
   that measure power, each with its watts right now: the one the PC is on is
   drawing tens of watts. A plug whose name has characters Threadgarden can't
   use is greyed out with a note: rename it on the switch's console with
   `ZbName <id>,<name>` and press Refresh. For a new plug, **Pair a new
   plug…** opens Zigbee pairing on the bridge for 60 seconds (hold the plug's
   button until its LED blinks fast) and names it "‹machine›_plug".
3. **Check.** Threadgarden shows the plug's watts, with **Refresh**. **Off
   below** (default 5 W): the machine counts as off under that many watts.
   **Wait before switching on** (default 90 s): how long power stays cut
   before it comes back. Nothing in setup switches the plug off, since the PC
   is running on it.
4. **Save.** Threadgarden installs what it needs on the switch (4.5). The
   machine's heading now has a **⏻** menu, and Settings shows the plug, its
   watts and the settings. After the first shutdown Threadgarden measured,
   Settings suggests an off line between the lowest running draw and the
   shut-down reading.

**The ⏻ menu.** **Turn on** switches the plug on (if the PC is standing by with
the plug already on, it cuts power, waits, and switches it on again; it does
that only on a fresh reading from the plug, and otherwise asks you to try
again). The machine then shows **Starting…**, and **Unreachable** if it has
not answered after 5 minutes. **Shut down now** starts the shutdown below; on
a machine that is working on something it asks first. **Keep awake**
stops idle shutdown for 1 hour, 4 hours or until you turn it off, and survives
a service restart. The states are **Off**, **Starting…**, **On**, **Shutting
down** and **Unreachable**; hover over the state to see "Shuts down in 42 min".

**Shut down after idle** (Settings → Power: Never, 30 min, 1 hour, 2 hours or
4 hours; default 1 hour) is kept on the machine itself, so it works with every
window closed. You can change it only while the machine is On. A machine is busy while a chat on it is mid-turn, while a
background agent a chat started is still running, or while a Claude Code
session Threadgarden did not start is working (the last one is only seen while
the "external sessions" polling setting is on). A chat waiting for your answer
counts as idle, and a dev server or file watcher left running by a chat does not
keep the machine awake.

**What a shutdown does.**

1. It checks every repository the machine's chats worked in for work that
   exists only on that disk: uncommitted changes (including untracked files that
   are not ignored), commits on no remote branch, commits on a detached HEAD,
   and stashes. A repository it cannot check also pauses the shutdown; a
   repository without a remote is skipped.
2. If it found something, the machine stays on and Needs you shows **Unpushed
   work on ‹machine›**, with **Ask Claude to push it** and **Shut down
   anyway**. Nothing is deleted either way. Once a chat there starts or ends a
   turn, the notice goes away and the check runs again after the next idle
   period.
3. If a scheduled message is due within 15 minutes, the shutdown is postponed
   (one already overdue goes out when the machine is next on).
4. Otherwise it arms the power cut on the switch (and, if a scheduled message
   is due within 7 days, a wake for 5 minutes before it). If a chat got to work
   meanwhile, it disarms again and the machine stays on. Otherwise it stops the
   chats (they become resumable) and runs `systemctl poweroff`.
5. The switch cuts the power once the plug has read below the off line for about
   30 seconds. It never cuts on a timer alone, so a PC that hangs while shutting
   down keeps its power.

If the switch cannot be reached or refuses, the machine **stays on** and
Threadgarden says why: powering it off without being able to switch it on again
would strand it.

**Remove power control** (Settings → Power) takes Threadgarden's rule off the
switch and forgets the switch. If the machine is off at that moment, it is told
when it is next on. Removal is best effort: if the switch cannot be reached or
its password has changed, Threadgarden's rule stays on it, inert, and setting up
again reuses that slot. `SetOption83` stays on either way.

### 4.5 What Threadgarden changes on your switch

On a switch, Threadgarden uses only:

- one **rule slot** (1, 2 or 3): a free one, or the one it used before;
- **RuleTimer** 6, 7 and 8, **Var** 14 and 15, **Mem** 11 to 14, and **Timer16**
  (the wake).

It never touches your other rules, timers, variables, devices, Wi-Fi settings
or firmware, and never removes a Zigbee device. If something of yours already
uses one of the above, setup stops with an explanation instead of taking it,
and it says so if no rule slot is free. On a Zigbee bridge it also sets
`SetOption83 1` (devices addressed by name), but only if none of your rules
names a Zigbee device by its address. Remove power control and its rule and
timer go away again (see 4.4 for what Remove leaves).

One switch powers one machine for now: its one rule slot belongs to that
machine, even on a Zigbee bridge with several plugs. Setting up a second
machine on the same switch stops with "This switch already powers ‹machine›";
remove power control from the first machine, or give the second its own
switch.

Two more things. Wakes use Tasmota's timers, so Tasmota's global **Timers**
switch must be on (Configuration → Configure Timer). With it off and a message
scheduled within the next 7 days, shutdowns stop too, until you turn it back on
(`Timers 1` on the console), since the wake could not happen. And Threadgarden sends the
`Referer` header Tasmota 16 wants itself, so you do not need `SetOption128`; if
a switch still refuses requests, enter `SetOption128 1` on its console.

### 4.6 Security

Tasmota has no TLS, so the web password crosses your network in clear text. Keep
the switch on your home network behind your router, never forwarded to the
internet, and give it a web password. Threadgarden keeps the password in the
desktop's credential store and, on the Ubuntu PC (whose own service arms the
cut), in `~/.local/share/threadgarden/power-switch.json`, readable only by your
user. It never appears in the interface, logs or errors after you type it.

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
| **Starting…** then **Unreachable** | The plug came on but the service did not answer within 5 minutes. | Check the BIOS setting and the wait (see "Stays Off after Turn on" below), that Wi-Fi connects at boot without a login, and that the service starts (`systemctl --user status threadgarden`). A first headless boot can take a few minutes. Press **Turn on** again once it is up or has been reset. |
| **Shutdown paused: unpushed work** | Needs you shows "Unpushed work on ‹machine›": a repository there has changes, commits or stashes that are on no remote branch, or it could not be checked. | **Ask Claude to push it**, or push over SSH, then shut down again. **Shut down anyway** leaves the work on the machine's disk. |
| **The power switch refused the password** | The switch rejected `admin` with the saved password, so the machine stays on. | Set the password again in Settings → Power (remove power control and set it up again). On Tasmota 16, if requests are refused even with the right password, enter `SetOption128 1` on the switch's console. |
| **Stays Off after Turn on** | The plug is on but the PC does not boot. | Check the BIOS "Restore on AC power loss" = On (4.3), and that **Wait before switching on** is long enough: a PC cut for less than about 10 s may not notice the power return. To change it, start the PC by hand (its power button) and wait until it shows On, then remove power control and set it up again with a longer wait (90 s is proven). |
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
sudo rm /etc/polkit-1/rules.d/49-threadgarden-power.rules
```

That removes the program. Threadgarden's own data on the PC (its database
with the paired devices, its certificate and its logs) stays in
`~/.local/share/threadgarden`; delete it too with
`rm -rf ~/.local/share/threadgarden`. Claude Code and its history
(`~/.claude`) are not touched. If nothing else needs lingering:
`sudo loginctl disable-linger $USER`.
