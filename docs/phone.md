# Threadgarden on the phone

The Android app shows the chats of all your machines, the main PC included:
read them, answer Claude, start new chats, and turn a machine on through its
plug. It tells you at once when a chat needs you or finishes, with the app
closed. It never runs Claude Code itself. Every chat runs on one of your
machines.

There's no cloud: the phone connects straight to each machine over your
network, or over a VPN you set up (Tailscale, below).

## Install

You need Android 8 or newer on a 64-bit ARM phone (almost every phone from the
last few years).

1. On the phone, open the
   [latest release](https://github.com/JiriPlasek/ThreadGarden/releases/latest)
   and tap `threadgarden-<version>.apk`.
2. Android asks to allow installs from the browser the first time
   (**Install unknown apps**). Allow it for that browser, then install.
3. Open Threadgarden. It asks to post notifications, then explains why it
   should run in the background and opens Android's battery dialog. Allow both:
   without them alerts come late, or not at all.

## Reaching home from outside: Tailscale

At home the phone reaches your machines on the home network. Away from home,
put the phone and the machines on one [Tailscale](https://tailscale.com)
network: install Tailscale on the phone and on each machine, and sign in to
the same account. Each device then has a `100.x.y.z` address that works from
anywhere.

Pair with each machine's Tailscale address, and it works both at home and
away. A machine paired by its home address can be given its Tailscale address
later in Settings → Machines (the pairing stays).

## Pairing

**A machine running the headless service** (the Ubuntu PC of
[Remote machines](remote-machines.md), or a Windows worker): over SSH, run
`threadgarden pair` for a one-time code. On the phone: Settings → Machines →
**Add machine…**, then the machine's address and the code.

**The main PC** (the desktop app): it doesn't listen for other devices unless
you ask. On the PC, Settings → Machines → **Let my phone connect**. It shows
the addresses the phone can use (the Tailscale one among them, if the PC has
Tailscale), and **Show a pairing code**. Windows may ask to allow
Threadgarden through its firewall: allow it on private networks. Then on the
phone, **Add machine…** with one of those addresses and the code.

While it's on, the PC doesn't stop its service when idle. After a restart,
it's reachable once someone signs in to Windows. **Start at sign-in**, offered
next to the setting, starts Threadgarden with Windows. Turning the setting off
disconnects the phone at once; it stays paired, and connects again when the
setting is back on.

## Plug details and Turn on

A machine that's off can be turned on from the phone, through the same
Tasmota plug the desktop uses ([Power control](remote-machines.md#4-power-control)).
The phone keeps its own copy of the plug's details: in a machine's ⏻ menu,
**Plug details…**, then the bridge's or plug's address, the Zigbee plug's name
exactly as the bridge has it, and the plug's web password. The phone checks the
password and the name when you save, and never shows the password again.

- A machine without details says "Enter this machine's plug details to turn it
  on from here". This includes the main PC: give it its plug's details to turn
  it on from the phone.
- **Set up power control on the desktop first.** Turning on a machine that sits
  in standby (its plug on, drawing little) needs a short power cut. The phone
  does that only through the rule the desktop installs on the bridge, and only
  when that rule is for this exact plug. Without it the phone says so ("Set up
  power control on the desktop first"). A plug that's simply off is switched
  on either way.
- The phone never cuts a running machine's power. **Shut down now** and
  **Keep awake** are the machine's own, as on the desktop, and only for
  machines with power control (not the main PC).

## Staying connected

A permanent notification, **Connected to your machines**, keeps the
connections alive and says how many machines are reachable. It's what lets
alerts arrive with the app closed: `‹machine›: ‹chat› needs you` and
`‹machine›: ‹chat› finished`. Tapping one opens the chat.

- **Disconnect** (on the notification, or Settings → This phone) closes every
  connection and removes the notification: no alerts until you open the app,
  or tap **Connect**. After a reboot the phone reconnects only if it was
  connected before.
- **The battery exemption:** Settings → This phone says whether Android lets
  Threadgarden run in the background, with **Allow in the background** if not.
- **Phone makers' own settings** can still stop it. On OnePlus, Xiaomi, Samsung
  and similar phones, also open the app's settings (long-press the icon → App
  info → Battery) and allow background activity, or set it to Unrestricted.

**Data use.** In the background the phone receives every chat's streamed
output from each machine, not only the alerts: around 180 MB in a busy hour.
Mind it on mobile data, or Disconnect when you don't need alerts. This is a
known limitation for now.

## Updates

When a new release is out, the app says "Threadgarden ‹version› is available"
when it starts. **Download** opens the APK in the browser; install it over the
old one. Your pairings stay. The app never downloads or installs anything by
itself.

## What the phone can do, and a lost phone

A paired phone has the same control as the desktop over each machine's chats:
read every chat, send messages, answer permission requests, start, stop and
move chats. On a machine with power control it can also shut it down or keep
it awake, and with plug details it can turn it on.

On the **main PC** it can do what any paired device can: everything with its
chats, and also change Threadgarden's settings and **Stop all work**. It
can't turn Let my phone connect on or off, pair other devices, or read the
API key.

The phone keeps each machine's token and the plug passwords encrypted with a
key from Android's Keystore, behind the phone's lock. **If the phone is lost
or stolen,** remove it everywhere:

1. **Each headless machine:** over SSH, `threadgarden devices` lists the paired
   devices; `threadgarden revoke <id>` removes the phone. Its connections close
   at once.
2. **The main PC:** Settings → Machines → Let my phone connect → **Remove**
   next to the phone (or turn the setting off).
3. **The plugs:** change each plug's web password in its Tasmota page, and
   enter the new one where the plug is set up on the desktop and the new
   phone.

Then pair the new phone as above.
