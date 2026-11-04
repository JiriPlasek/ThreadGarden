<p align="center">
  <img src="docs/images/logo.png" alt="" width="80">
</p>

<h1 align="center">Threadgarden</h1>

<p align="center">A desktop app for your <a href="https://code.claude.com/docs">Claude Code</a> chats.</p>

Threadgarden shows every Claude Code conversation you've had on this machine, runs new ones in tabs, and tells you when an agent is waiting on you. Close the window and your agents keep going. Got an old PC lying around? It can do the work instead.

It runs your own `claude` install, with your own login, through the official Agent SDK. Not affiliated with Anthropic.

> Still early. Expect rough edges.

<p align="center">
  <img src="docs/images/main-window.png" alt="The Threadgarden window: the places column on the left, a list of chats grouped by time, and an open chat that ran a command after asking permission." width="900">
</p>

## What's in it

- All your history in one place, grouped by project and searchable. File chats as Active, On hold or Archived so the list stays readable.
- Live chats in tabs, with proper rendering for code, diffs, todos and subagents. Permission prompts and questions are answered right in the chat.
- **Needs you** and **Running** lists across all projects, plus a tray badge and notifications, so you don't have to babysit tabs.
- Chats started in a terminal show up too.
- An activity panel to see what subagents and background processes are up to, and stop them.
- A usage meter for your plan limits, per Claude account (each machine's own), and "send when the limit resets" for that one message you'd otherwise forget.
- Remote machines: pair another computer on your network (an always-on Ubuntu box, say) and run chats there from the same window. [How to connect one](#connect-an-ubuntu-machine). With a VPN such as Tailscale that you set up yourself, it can be reached from outside home too.
- On any machine: start a new project, clone a GitHub repo, or browse to any folder.
- Move a chat to another machine, with its whole conversation (Move to…).
- Update a remote machine from Settings.
- Turns a remote machine on and off through a Tasmota smart plug, and cuts the power if a shutdown hangs.
- Analytics, if you're curious where your tokens go.
- A quick switcher (Ctrl+K), shortcuts for everything, themes.

## Screenshots

Taken from a build with made-up data. The text of its chats is nonsense on purpose.

<details>
<summary><b>Show the screenshots</b></summary>

<img src="docs/images/needs-you.png" alt="Needs you lists the one chat waiting for an answer; the open chat shows a permission request to run ls -la, with Allow, Always allow and Deny." width="700">

<img src="docs/images/move-chat.png" alt="The Move this chat dialog: the machine Ubuntu chosen, a folder there, and three passed checks: the chat isn't busy, the project is clean, Ubuntu is on." width="420">

<img src="docs/images/settings-machines.png" alt="Settings, Machines: a paired machine that is On, showing its Threadgarden version, that a newer one is available, and an Update button." width="700">

<img src="docs/images/usage.png" alt="The Usage dialog: 5-hour and weekly limits as bars, listed separately for each machine's Claude account." width="360">

</details>

## Install

Grab the [latest release](https://github.com/JiriPlasek/ThreadGarden/releases/latest):

- **Windows**: the `-setup.exe` (or the `.msi`)
- **macOS** (Apple silicon): the `.dmg`
- **Linux**: the `.AppImage`, or the `.deb` / `.rpm`

The builds aren't code-signed yet, so SmartScreen and Gatekeeper will grumble the first time you open it. After that the app updates itself (the updates are signed and checked). The deb and rpm installs just get a link to the new version.

You'll need Claude Code installed and signed in, or an Anthropic API key set in Settings. On Linux you also need WebKitGTK 4.1.

Want to build it yourself? See [CONTRIBUTING.md](CONTRIBUTING.md).

<details>
<summary><b>Coming from pahub?</b></summary>

Threadgarden used to be called pahub. Install it and start it: your data is copied over on first launch, and the old folder is left alone (delete it once you're happy). If an old pahub service is still running, restart it from the screen that shows up. Then uninstall pahub, and turn Start on login back on if you used it. The `PAHUB_*` environment variables still work for one more release; switch to the `THREADGARDEN_*` names.

</details>

## Connect an Ubuntu machine

An always-on Ubuntu PC (no screen needed) can run your chats while your own computer sleeps or is off. You set it up once, over SSH; after that you work from the same Threadgarden window. This is the whole recipe. More detail, troubleshooting and the optional parts are in [docs/remote-machines.md](docs/remote-machines.md).

<details>
<summary><b>The steps</b></summary>

Every command says where it runs: **Ubuntu** means a terminal on the Ubuntu PC (over SSH, once step 2 works), **Windows** means PowerShell on your own computer. Placeholders are in `<angle brackets>` or are examples (`192.168.1.50`, `MyWiFi`): replace them with your own values.

### 1. What you need

- An Ubuntu PC, 22.04 or newer, x64, on the same home network as your computer (a screen and keyboard for the first minutes, then it can run without).
- A Claude subscription or an Anthropic API key, for Claude Code on that PC.
- Your router's admin page, to give the PC a fixed address.

### 2. SSH

On **Ubuntu**:

```sh
sudo apt update
sudo apt install -y openssh-server curl
sudo systemctl enable --now ssh
hostname        # the PC's name, e.g. ubuntu-pc
hostname -I     # its address(es), e.g. 192.168.1.50
```

On **Windows** (PowerShell; the SSH client is built in), with your Ubuntu user name and the address from `hostname -I`:

```powershell
ssh <your-ubuntu-user>@192.168.1.50
```

Everything below runs on the Ubuntu PC over that SSH connection, unless it says Windows.

### 3. Wi-Fi at boot, without logging in

Skip this if the PC is on a network cable. A Wi-Fi set up in Ubuntu Desktop's settings may keep its password in your login keyring, so the PC is only online after someone logs in. Make it a system connection that connects for every user at boot. On **Ubuntu**:

```sh
nmcli -f NAME,TYPE,AUTOCONNECT connection show
```

Use the Wi-Fi's NAME from that list in place of `MyWiFi`, and your real password:

```sh
sudo nmcli connection modify "MyWiFi" connection.permissions "" connection.autoconnect yes
sudo nmcli connection modify "MyWiFi" 802-11-wireless-security.psk-flags 0 802-11-wireless-security.psk "your-wifi-password"
history -c      # the password is in your shell history; this clears it
```

On **Ubuntu Server** without NetworkManager, the Wi-Fi the installer set up (netplan) already connects at boot: skip the two `nmcli` commands.

Optionally, stop the PC from sleeping when idle (Ubuntu Desktop may suspend):

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Check it: `sudo reboot`, do not log in at the PC, and after a few minutes (a first headless boot can be slow) connect again from **Windows** with the same `ssh` command. If that works, the PC comes up on its own.

### 4. A stable address

Threadgarden finds the PC by the address you give it, so the address must not change. Pick one.

- **A DHCP reservation (recommended).** In your router's admin page, find the DHCP settings (on TP-Link: Address Reservation) and reserve the PC's current address for its Wi-Fi MAC address. On **Ubuntu**, the MAC is the `link/ether` value of the Wi-Fi device (the one starting with `wl`):

  ```sh
  ip link
  ```

- **Its `.local` name.** Ubuntu announces `<hostname>.local` on the network. On Ubuntu Server install the announcer first (on **Ubuntu**: `sudo apt install -y avahi-daemon`). Test from **Windows**, with the name from `hostname`:

  ```powershell
  ping ubuntu-pc.local
  ```

  If that fails from Windows, use the reserved address instead.

If Ubuntu's firewall is on (`sudo ufw status` says "active"), allow Threadgarden's port on **Ubuntu**:

```sh
sudo ufw allow 47380/tcp
```

### 5. Claude Code

On **Ubuntu**:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

This puts `claude` in `~/.local/bin`, where the Threadgarden service looks for it. Log out and in again (or run `source ~/.profile`) so `~/.local/bin` is on your `PATH`, then sign in:

```sh
claude
```

Choose how to sign in. Over SSH no browser opens: Claude Code prints a link. Open it in the browser on your own computer, sign in, and paste the code it shows back into the SSH window. Send a short message to check it answers, then leave with `/exit`. If chats there later fail because the sign-in expired, sign in the same way again.

### 6. git and the GitHub CLI

Claude works in git repositories there and pushes with your GitHub account. On **Ubuntu**:

```sh
sudo apt install -y git gh
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
gh auth login --insecure-storage
gh auth setup-git
```

In `gh auth login` choose GitHub.com, HTTPS and "Login with a web browser": it prints a one-time code and the address `https://github.com/login/device`; open that on your own computer and enter the code. `--insecure-storage` keeps the token in `gh`'s config file instead of the desktop keyring: a PC that logs in without a password leaves the keyring locked, and the headless service could not read a token kept there. Threadgarden itself never stores GitHub credentials. (You can skip this step; everything else works, but Clone and "Create a GitHub repo" won't.)

### 7. The Threadgarden service

On **Ubuntu**, download the latest release's package and its checksum into a new, empty folder:

```sh
rm -rf ~/threadgarden-download && mkdir ~/threadgarden-download && cd ~/threadgarden-download
base=https://github.com/JiriPlasek/ThreadGarden/releases/latest/download
curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz"
curl -fLO "$base/threadgarden-headless-linux-x64.tar.gz.sha256"
```

Check the download, unpack it, and run the installer **as your own user, not with sudo**:

```sh
sha256sum -c threadgarden-headless-linux-x64.tar.gz.sha256
tar -xzf threadgarden-headless-linux-x64.tar.gz
cd threadgarden-headless-*/
./install.sh
```

`sha256sum` must print `OK`; if not, download again and do not install. The installer puts the service under `~/.local/share/threadgarden-headless`, links the command `~/.local/bin/threadgarden`, installs a systemd user service and starts it. It runs `sudo` twice, explaining each first, and may ask for your password:

- `loginctl enable-linger`: lets your user's services start at boot and keep running after you log out. Accept it, or Threadgarden only runs while you are logged in.
- A small polkit rule: lets the service power the machine off (idle shutdown). Only needed for [power control](docs/remote-machines.md#4-power-control); press Ctrl+C to skip it if you won't use that.

Check that it runs:

```sh
threadgarden status
```

It should say `Threadgarden <version> is running (protocol <n>, headless).` and `Listening for devices on 192.168.1.50:47380` (with your address). If it says `command not found`, log out and in again so `~/.local/bin` is on your `PATH`. Optionally give the machine the name Threadgarden shows (the host name until you do):

```sh
threadgarden rename "Ubuntu PC"
```

If `claude` lives somewhere other than `~/.local/bin` or `/usr/local/bin`, the service won't find it: see [the PATH note](docs/remote-machines.md#the-threadgarden-headless-service).

### 8. Pair it

On **Ubuntu**:

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

It lists every private address the PC listens on (here `172.17.0.1` is Docker's); use the one you reach the PC at. The code works once, for 5 minutes; running the command again replaces it. Then, in Threadgarden on your own computer:

1. Open **Settings** (the gear at the top of the places column), scroll to **Machines** and click **Add machine…**.
2. **Address**: the address you use for `ssh` (`192.168.1.50`), or `ubuntu-pc.local`. If `Port:` is not 47380, open **More** and enter it.
3. **Pairing code**: the code (dashes and case don't matter).
4. **This device's name**: how the Ubuntu PC will list your computer. It starts as this PC's name.
5. Click **Pair**.

The dialog closes, the machine shows as **On** in Settings → Machines, and the places column gets a group for it under This PC. If pairing fails, [the troubleshooting table](docs/remote-machines.md#when-pairing-fails) says what each message means.

### 9. A first chat there

Click **New chat** (the + beside the tabs, or Ctrl+N), choose the machine under **Machine**, and start in its **Home folder**, a **New project** or a **Clone**. A folder there becomes a project once a chat has run in it.

### 10. Updating later

If the machine runs 0.8.0 or newer, open Settings → Machines. When it is behind, its card says so and has an **Update to ‹version›** button (the Settings button shows a small dot). Press it: the machine downloads the release, checks it, installs it and restarts, and goes back to the old version by itself if the new one doesn't answer.

For an older machine, or after a failed update, do it by hand. On **Ubuntu**, repeat the download from step 7 (a new, empty folder), then:

```sh
sha256sum -c threadgarden-headless-linux-x64.tar.gz.sha256
tar -xzf threadgarden-headless-linux-x64.tar.gz
cd threadgarden-headless-*/
./install.sh
```

The installer keeps the previous version, so going back is one command:

```sh
ls ~/.local/share/threadgarden-headless/
~/.local/share/threadgarden-headless/<previous-version>/install.sh
```

</details>

Optional, in [docs/remote-machines.md](docs/remote-machines.md):

- **Power control:** turn the PC on and off from Threadgarden with a Tasmota smart plug: [Power control](docs/remote-machines.md#4-power-control).
- **Away from home:** with a VPN you set up yourself (Tailscale, say): [What it does](docs/remote-machines.md#what-it-does).
- Taking it off again: [Uninstalling](docs/remote-machines.md#uninstalling).

## Your data

Threadgarden never writes to `~/.claude`. It reads your history through the Agent SDK, and the only things that land there are Claude Code's own transcripts of the chats you run.

Its own data (a search index of your chats, your titles, drafts and settings) lives in `%APPDATA%\threadgarden`, `~/Library/Application Support/threadgarden` or `~/.local/share/threadgarden`. Delete the folder to start fresh. It holds the text of your chats, so treat it like `~/.claude`. A chat moved to another machine is kept there, in Threadgarden's own data, not in `~/.claude`.

API keys and pairing tokens go to your OS keychain. The app itself only talks to localhost, your paired machines, GitHub (for updates) and the power switch on your network, if you use one. A paired machine downloads its own updates from GitHub. `claude` talks to Anthropic as it always does.

## Login and terms

There's no Threadgarden account. It uses whatever Claude Code uses: a subscription, an API key or a third-party provider. Anthropic's Agent SDK docs say third-party products shouldn't offer claude.ai login unless approved, and point to API keys instead. Whether your setup is fine is between you and Anthropic's terms, so give them a read (this isn't legal advice). There's also an API-key-only build, `THREADGARDEN_API_KEY_ONLY=1`. More in [docs/architecture.md](docs/architecture.md#authentication).

## Known limitations

- Tabs only: no split view, no embedded terminal.
- No `bypassPermissions`, and terminal-only commands like `/config` or `/login` don't work here.
- Chats running in another terminal are shown, not driven. You get a command to hand them over.
- After Claude Code compacts a chat, history starts at the compaction (that's all the SDK returns).
- Clicking a notification only brings the window forward; it doesn't open the chat. Coming back to the window never changes your place or tab.
- A moved chat isn't listed by `claude --resume` on the machine it moved to (continue it in Threadgarden), and can't be forked yet.
- A machine's chats aren't shown while it is off.
- macOS and Linux pass CI but haven't seen much real use yet.

## Keyboard shortcuts

Press **Ctrl+/** (**⌘/** on macOS) or **?** to see them in the app. "Ctrl" means ⌘ on macOS, except in Ctrl+Tab.

<details>
<summary><b>All shortcuts</b></summary>

**Global**

| Keys        | Action                                                           |
| ----------- | ---------------------------------------------------------------- |
| Ctrl+K      | Open the quick switcher (chats, projects, messages and commands) |
| Ctrl+/ or ? | Show keyboard shortcuts                                          |
| Ctrl+N      | Start a new chat (in the selected project)                       |
| Esc         | Close a dialog or menu                                           |

**Tabs**

| Keys           | Action                                |
| -------------- | ------------------------------------- |
| Ctrl+W         | Close the active tab                  |
| Middle-click   | Close the tab under the pointer       |
| Ctrl+Tab       | Next tab                              |
| Ctrl+Shift+Tab | Previous tab                          |
| ← or →         | Previous or next tab (focus on a tab) |
| Home or End    | First or last tab (focus on a tab)    |
| Delete         | Close the focused tab                 |

**Chat list**

| Keys                 | Action                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| ↑ or ↓               | Move through the chats                                                    |
| Page Up or Page Down | Move a page of chats at a time                                            |
| Home or End          | First or last chat                                                        |
| Enter or Space       | Open the selected chat                                                    |
| ↓                    | From the search field, go to the list                                     |
| Esc                  | Clear the search                                                          |
| E                    | Archive the selected chats (or the one under the cursor)                  |
| H                    | Put on hold: choose until when and add a note                             |
| A                    | Make active (back from On hold or Archived)                               |
| Ctrl+Click           | Add a chat to the selection, or remove it                                 |
| Shift+Click          | Select a range of chats                                                   |
| Shift+Space          | Add the chat under the cursor to the selection, or remove it              |
| Ctrl+A               | Select every chat of the cursor's section (else of the first one in view) |
| Esc                  | Clear the selection                                                       |

**Composer**

| Keys                                                           | Action                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| Enter (Ctrl+Enter when "Enter sends the message" is off)       | Send the message (queued while Claude works)                 |
| Shift+Enter (also Enter when "Enter sends the message" is off) | New line                                                     |
| Esc                                                            | Stop Claude while it is working                              |
| @                                                              | Mention a file or folder                                     |
| /                                                              | Slash commands (at the start of the message)                 |
| Ctrl+V                                                         | Paste images, or a file path as a mention                    |
| Esc                                                            | Close the "Deny with feedback" field of a permission request |

**Pickers** (the `@` and `/` suggestions, and the quick switcher)

| Keys         | Action                                           |
| ------------ | ------------------------------------------------ |
| ↑ or ↓       | Move through the suggestions                     |
| Enter or Tab | Insert the selected file or command              |
| Esc          | Close the suggestions                            |
| ↑ or ↓       | Quick switcher: move through the results         |
| Enter        | Quick switcher: open the chat or run the command |

**Interface**

| Keys             | Action                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| Ctrl+.           | Show or hide the Activity panel (agents and background processes)           |
| Ctrl+= or Ctrl++ | Larger interface                                                            |
| Ctrl+-           | Smaller interface                                                           |
| Ctrl+0           | Default interface size                                                      |
| ← or →           | Narrow or widen a column (focus on its divider; with Shift in bigger steps) |
| Home or End      | Narrowest or widest column (focus on its divider)                           |
| Double-click     | Reset a column's width (on its divider)                                     |

</details>

## License

Not yet chosen: all rights reserved until a license is added.
