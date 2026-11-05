# A machine that's away: design

Date: 2026-11-04. Status: agreed with the owner in brainstorming (the mockup of a chat on an Off machine was approved: "lgtm"), checked by a builder, with the owner's answer on new chats folded in; awaiting their read of this document.

This is part A of plan 3. Part B, a Windows machine as a worker, has its own design.

## Why

The owner's Ubuntu PC (`kumbal-machine`) is switched off most of the time by idle shutdown and the smart plug. Today an Off machine's group in the places column shows only its heading, its state and **Turn on**, plus "Its chats appear once it's on". Nothing can be typed for it.

The owner wants this: "I would like to open some chat and type there - that would trigger the PC to turn on and then the message would send, and for this I need to see the chats while its off." Typically from the laptop away from home, through the owner's own VPN.

**Success:** with kumbal off, the owner opens one of its chats, sees the last few messages, types a reply and presses send. Kumbal turns on, and a couple of minutes later the message has gone out and Claude is working. Nothing typed is ever lost.

## Goals (owner)

1. **See an Off machine's chats.** Its group keeps its projects and its chat list, titles, states and Needs you included, as they were when last seen, with "last seen ‹time›".
2. **A few messages per chat, not the full conversation.** "maybe just couple messages, does not have to be full convo." Every chat on that machine gets them, not only chats opened before.
3. **Type and send into an Off machine's chat.** Sending turns the machine on and sends the message once it's up. Opening a chat never turns it on.
4. **The message waits on the device it was typed on** (option A). It's saved to disk at once, so it survives the app closing or the device sleeping. It goes out when that device is awake and the machine is up. If the lid closes first, it goes out the next time the device is awake, turning the machine on again if needed.
5. **Nothing extra to own.** No Raspberry Pi or other always-on helper: "the whole setup would be too custom and hard to replicate for others." It must work for anyone with Threadgarden and a second PC.

Decided in the first remote-machines design (2026-10-31) and still binding:
- Opening a chat never boots the machine; sending a message, answering a prompt, or Move to… does.
- Starting work on an Off machine: a new chat opens at once with "Starting ‹machine›…", and its first message waits like a queued one. The owner never waits at a spinner. Confirmed by the owner on 2026-11-04.
- The copy is Threadgarden's own data on the client, never Claude Code's.

## Non-goals

- Full conversations offline. Only the last few messages.
- Delivery while every device is asleep (that would need an always-on helper, goal 5).
- A phone app.
- Analytics combined across machines, listed under plan 3 before but not part of this.
- A Windows worker: part B.

## Anti-goals

- **A lost message.** Anything typed is on disk before the composer clears, and stays until the machine has accepted it, or the owner cancels it.
- **A message sent twice,** for example after a retry, a reconnect or two queues racing.
- **Booting a machine by looking at it.**
- **A copy mistaken for the live chat.** A copy is always marked as one.

## What the owner sees

**The places column, machine Off** (as in the approved mockup):
- The machine's group shows **Off · ⏻**, "last seen 2 h ago", its projects, and its chats in the lists (Active, Needs you, Running…).
- Its chats look as they did when last seen, each with the machine chip as today.
- A machine never seen by this device since pairing shows today's "Its chats appear once it's on".

**A chat opened from the copy:**
- A note on top: "‹machine› is off: showing its last few messages, from ‹time› ago." Above the messages: "… earlier messages are on ‹machine›".
- The last few messages. My call: about the last 10, as text, with tool steps folded away.
- The composer works if the machine can be turned on (it has power control).
- Without power control it's disabled, with "‹machine› is off; turn it on to send".

**After pressing send:**
- The message shows at the end of the chat at once, with "⏳ Waiting for ‹machine› — turning it on, sends when it's up. Keep this device awake. · Cancel".
- The machine is turned on at once, through power control as today.
- Several messages, in one chat or in several, queue in order. Cancel removes one that hasn't gone out.
- When the machine is up, the queued messages go out in order, and the copy becomes the live chat.
- **If it doesn't come up** within power control's existing start window: the line says why, with **Retry**, and the message stays.
- **A pending permission prompt or question** in the copy, whose process ended at shutdown, can be answered; the answer is sent as the next message. The builder phrases it, as the first design left open.
- **Move to…** an Off machine already turns it on first; unchanged.

**A new chat on a machine that's not connected** (owner, 2026-11-04: "new chat on off machine - yes"):
- New chat offers that machine too, under its last seen state.
  - **Existing folder** lists its projects from the copy, plus its Home folder.
  - **New project, Clone and Browse…** are disabled while it's away, with "Available when ‹machine› is on", since they need the machine.
- Sending opens the chat at once in a tab: "Starting ‹machine›…", with the first message waiting, as in the first design. It follows the same rules as a waiting reply: turned on if the plug reads Off, saved to disk, Cancel, Retry.
- The chat doesn't exist on the machine yet, so it needs a stand-in id on this device until the machine creates it. Then the tab, the list and any further queued messages move to the real chat without the owner noticing.
- Model and permission mode are chosen as today and travel with the first message.

## Calls made after the builder check (mine, for the owner to check)

- **The copy shows whenever this device isn't connected to the machine:** Off, Unreachable or Connecting. That's not only when the plug reads Off. Without power control a switched-off PC shows Unreachable, and a powered one does too while the plug can't be read, for example before the VPN is up.
- **Sending is allowed in any of those states, and the message waits.** The machine is turned on only when the plug reads Off.
  - In any other state, the line says "Waiting for ‹machine› — sends when it's reachable". This includes a machine without power control, so its composer isn't disabled after all; it just can't turn the machine on.
  - A machine that may already be running is never cut and restarted to send a message.
- **The queue is only for sends to a machine this device isn't connected to.** Sending to a connected machine stays exactly as today.
- **Retries:**
  - A start interrupted by this device sleeping, or the app closing, counts as not tried. On waking, the machine is turned on again by itself.
  - A start that runs its whole window with the device awake and the machine never answering is a real failure. It waits for **Retry**, so a PC that won't boot isn't power-cycled on every wake.
- **From outside home,** turning the machine on needs a VPN that reaches the home network and the switch on it (a subnet router), not just the PC. The guide says so. At home it just works. This is the owner's own network setup, not a part Threadgarden depends on, so goal 5 holds.

## How it works (decided)

- **The copy lives on each client device,** in its local service's own data: the machine's projects and chat list (with Needs you and states), plus the last few messages of each chat.
  - It's refreshed whenever the device is connected to that machine. My call: on each list change and on disconnect; the builder picks the mechanism.
  - "last seen" is when it was last refreshed.
- **The queue lives on the client device too,** in its local service's database, so it survives the app and the window closing.
  - The local service delivers it when it can reach the machine, without the window open, and turns the machine on when there's something waiting.
  - On the device waking or the service starting with messages waiting, it turns the machine on again if needed.
- **Exactly once:** each queued message carries an id the machine remembers, so a retry or a reconnect can't send it twice. This follows Move to…'s pattern of ids chosen by the desktop.
- **Each device keeps its own copy and queue.** A laptop and the main PC don't share theirs.
- **Protocol:** a protocol bump if the machine must accept a message with an id. An older machine shows "Update ‹machine› to send while it's off". Machines now update from Settings (0.8.0).

## Left to the builder

- How the copy is fetched and stored, its size limit and eviction.
- How queued messages map onto the machine's existing send and scheduled-send paths.
- Wording, within the meanings above.
- Tests: the e2e mock machine can be "off" (power control's fake switch exists).
- Docs: `docs/remote-machines.md`, `docs/architecture.md`, and the README's feature line.
