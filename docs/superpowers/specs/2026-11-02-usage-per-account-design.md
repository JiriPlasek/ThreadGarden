# Usage per account: design

Date: 2026-11-02. Owner: Jiří Plášek. It refines the remote machines design (`2026-10-31-remote-machines-design.md`, §7 "Usage meter") and the v1.3 usage design (`2026-10-31-v1.3-design.md`, §3). Where they differ, this document wins. It covers the usage half of the plan 3 item "Analytics and the usage meter combined across machines". The analytics half stays in plan 3.

## 1. Why

The owner now signs in to a different Claude account on the Ubuntu PC (`kumbal-machine`) than on This PC.

**Today:**
- The usage meter in the bottom bar and the Usage dialog show **This PC's usage only**. The desktop's usage store is attached to the local service alone, so the Ubuntu PC's usage never appears.
- The old design's rule, "plan usage is account-wide; the meter shows the most recent reading from any machine", assumed one account everywhere, and it was never built.

**Success:** at a glance the owner sees each account's usage and which machines it covers. With one account everywhere, nothing looks different from today.

## 2. Decisions (owner)

- **Two accounts detected means usage is split, one entry per account.**
- **Labels:** each entry is labelled with **both** the machines signed in to that account and the account's email.
- **Bottom bar layout A, chosen from mockups:** always one chip per account, side by side, for example `This PC · 42% · 13:22` and `kumbal-machine · 91% · 11:05`. The chip names its machines. Hovering shows the email, and clicking opens the Usage dialog.
- **The chips show the breakdown of limits:** the 5-hour limit, the weekly limit, and per-model weekly limits such as Fable. The owner's example was "5h limit, weekly limit, fable limit".
  - Format: `This PC · 5h 42% · Week 18% · Fable 30%` *(designer's call)*.
  - Each chip lists only the windows that account reports. Each figure has its own warning colour, from that window's status and utilisation.
  - Reset times move to the hover, one line per window, for example "5-hour limit: 42%, resets 13:22". The email is on the first line of the hover.
  - When the bar is too narrow for all chips at full length, each chip drops the breakdown and keeps its machine names and its 5-hour figure (`kumbal-machine · 5h 91%`), so two chips can still be told apart; the bar never wraps. *(designer's call)*
- **Chats on another machine use that machine's limits** (owner, "YES"); see §5.
- **Usage dialog:** one section per account. Its heading is the email and plan, with the machines on that account. Each section has its own windows (5-hour, weekly, per-model, extra usage), as the dialog shows today.
- The owner approved the full playback in §3 to §5.

## 3. Which account a machine is on

- **Source:** each service learns its signed-in account from Claude Code's `accountInfo()`, which live sessions already call for the chat header's auth label (`packages/service/src/chat/live-session.ts`, `authLabel`). The service keeps the latest answer as **the machine's account**:
  - the email;
  - the plan (`subscriptionType`);
  - the auth kind: a claude.ai login, an API key, or a third-party provider.
- **The account is attached to the usage state.** `UsageState` gains the account: email, plan and kind. It is absent while unknown.
- **The account changes**, as when the owner logs in to another account (`/logout`, `/login` over SSH):
  - the next session's `accountInfo()` reports a different email;
  - the service then drops the usage windows it held, because they belonged to the previous account, and starts fresh for the new one;
  - refusals already recorded stay with their chats.

  *(designer's call)*
- **Unknown account:** this covers a fresh service start before any chat ran since the login changed.
  - The machine's readings are not merged with anyone's: it gets a chip of its own, labelled with the machine name.
  - Once the email is known, it joins its account's entry.
  - Readings are never guessed onto an account. *(designer's call)*
- **Persisted:** the last known account is stored with the usage state, so a restart doesn't make the account unknown until the next chat. *(designer's call)*

## 4. Grouping on the desktop

- **Which machines count:** the desktop reads the usage state of every machine it has a service for:
  - This PC (local);
  - every paired machine through its scope, with `usage.get` and then `usage.changed`, as This PC does today.
- **Grouping:** machines with the same account email form one **account entry**:
  - Its machines are listed This PC first, then in the order of the places column.
  - Each window (by key) takes the **newest** reading (`observedAt`) among that account's machines. This is the old "most recent reading" rule, now applied within one account.
- **A machine that is off or unreachable:** its last known usage state stays in its account entry, marked with when it was seen. The chip shows, for example, "as of 09:40"; the dialog says the same. Like the off machine's chat lists, it is kept on the desktop.
  - How the copy is stored is *(builder's call)*; the remote machines design §7 keeps local copies of off machines' lists.
  - With no copy at all, the machine is simply absent from usage.
- **API key or third-party provider** (`rateLimitsAvailable: false`) *(designer's call)*:
  - No email is reported, so there's nothing to group by. Each such machine is its own entry.
  - It gets **no chip** in the bar, because there are no limits to show, as This PC today.
  - It appears only in the Usage dialog, as a section titled with the machine's name and "API key" (or the provider's name, so `account` also carries the provider).
- **An account with no readings yet**, for example right after an account switch dropped the old windows: no chip until its first 5-hour reading. The dialog lists it with "No reading yet". *(designer's call)*
- **One entry in total:** the bar shows one chip, exactly as today. The chip names no machine when This PC is the only machine. With several machines on one account, the hover names them. *(designer's call)*

## 5. Limits inside a chat follow the chat's machine (owner)

**Today:** the desktop shows a usage-limit refusal only for This PC's chats (`ChatView.svelte`, around line 185: "Usage is This PC's only for now"). It also uses This PC's reset time for every chat's **Send when the limit resets** and for the "When the limit resets" option in the schedule dialog (`ChatView.svelte`, `ScheduledSends.svelte`, `ScheduleDialog`). The services themselves already work per machine: `scheduled.ts` computes the reset on its own machine.

**In this step** *(owner)*:
- **The "Usage limit reached" notice** shows for a chat on any machine, from that machine's usage state (its refusals).
- **Reset times:** **Send when the limit resets** and the "When the limit resets" option use the reset time of **the chat's own machine's usage state**. That is the same value its service will act on, not the merged account entry *(designer's call: what the user is told must match what the machine does)*. A machine with no known reset time hides those choices, as This PC does today.
- **Unchanged:** scheduled sends still run on their own machine. Each chip's warning colour follows its own windows.

## 6. Not in this step

- The analytics half of the plan 3 item, which adds up chats and tokens across machines.
- Switching accounts from Threadgarden. Logging in stays a terminal or SSH task.
- Cost estimates, auto-resume at reset, and snoozing (the "Usage extras" to-decide item).

## 7. Protocol and compatibility

- **Protocol 8.** `UsageState` gains an optional `account`: `{ email?: string; plan?: string; kind: 'login' | 'apiKey' | 'provider'; provider?: string }`. *(designer's call; field names are the builder's)*
- **The range of 7–9 lets a 0.6 desktop talk to a 0.5 remote (protocol 7):**
  - The remote's usage state then has no `account`, so it's treated as unknown.
  - It shows as its own machine-labelled chip, so it is never merged into another account by mistake.
- **Older desktops** ignore the new field.
- **Updating the Ubuntu PC** to the new version is still a manual step until plan 3, as with 0.5.0.
