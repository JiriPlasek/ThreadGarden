# Sign in to Claude from Threadgarden

The owner approved the approach on 2026-11-27. This change ships in 0.12.1.

## Amended by the owner (2026-11-27, after the build)

- **No Settings section.**
  - The **Claude accounts** section in Settings is removed.
  - Signing in is only `/login` in a Claude chat, or **Sign in to Claude** under a turn that failed on login.
  - Either one opens the same dialog for that chat's machine: Claude Code's own link, then paste the code. It's the same procedure as running `claude` in a terminal on a machine that isn't logged in.
- **`/logout`** in a Claude chat logs Claude Code out on that chat's machine. It runs Claude Code's own `claude auth logout` there, after a confirmation.
- **Switching account** is `/logout`, then `/login`. There is no separate Switch account.
- Everything else in this design stands:
  - the failure line;
  - the restart after a sign-in;
  - secrets never logged;
  - the API-key refusal;
  - the `claude-login` capability.

## Why

On 2026-11-25, after kumbal updated to 0.12.0, every turn there failed at once with "Failed to authenticate: OAuth session expired and could not be refreshed". Claude Code's own login on that machine had expired. The only fix was to SSH into kumbal, run `claude` and type `/login`. Threadgarden is meant to make the machines usable without a terminal, from the desktop and from the phone. The owner also wants to choose which Claude account a machine uses.

## Goals

- **The Claude account of each machine** in Settings: This PC, each paired machine and a Windows worker. Each row shows the account (email, plan) or "Not signed in", with **Sign in** or **Switch account**. It works from the desktop and from the phone.
- **Signing in:**
  1. The machine starts a sign-in, and Threadgarden shows its link. You open it anywhere: on This PC, or with a tap on the phone.
  2. You approve on claude.ai and paste the code it shows back into Threadgarden.
  3. The machine keeps the new login.
- **A failed chat leads there:**
  - A turn that fails on login shows **Sign in to Claude** under its error line. It opens the sign-in for that chat's machine.
  - `/login` typed in a Claude chat opens the same sign-in.
- **After a sign-in or a switch,** the live Claude chats on that machine restart between turns. Then the new login is in use everywhere. This is the same restart MCP removals use: it waits for the turn, open requests, queued messages, running tasks, a `!` command and a `/loop` timer.

## Non-goals

- Console (API key billing) login, and the cloud gateway login. This is the claude.ai login only (`loginWithClaudeAi: true`).
- Signing out.
- Codex chats and Codex's own login.
- Machines that use an API key, set in Threadgarden or in the environment. Their row says "Uses an API key" and offers no sign-in.

## Anti-goals

- Threadgarden never writes Claude Code's login or config files. Claude Code's own sign-in does the writing.
- The code you paste and the address you open are never logged, and never put in events, errors or the database.

## Approaches

- **Threadgarden's own sign-in dialog, driven by the SDK's login controls (chosen by the owner).** The SDK 0.3.314 has undeclared `claudeAuthenticate(loginWithClaudeAi)`, `claudeOAuthCallback(authorizationCode, state)` and `claudeOAuthWaitForCompletion()`, next to the MCP ones we already use. The account comes from the declared `accountInfo()`. The flow works like the MCP sign-in. Risk: the controls are undocumented, so a spike checks them first.
- Run `claude auth login` in the `!` terminal (PTY), inside a dialog. It's always Claude Code's own flow, but it's a terminal in Settings, clunkier on the phone, and reading the account would mean parsing `claude auth status`. It's the fallback if the spike fails.
- Write the credentials file ourselves. Rejected by the anti-goal.

## Decided

```
Settings → Claude accounts
  This PC     you@example.com · Max        [Switch account]
  kumbal      Not signed in                [Sign in]
  Win worker  Uses an API key

Sign in to Claude (kumbal)
  1. Open this link and approve:  https://claude.ai/oauth/authorize?…  [Copy] [Open]
  2. Paste the code claude.ai shows you:  [______________]
                                              [Cancel] [Sign in]
```

- **What the row knows (builder check, controller's call):**
  - The row shows the account the machine's chats last reported (`accountInfo()` at a process's start; usage already stores it as `@account`). It never starts a Claude process just to ask, which is usage's rule too.
  - When a turn on that machine fails on login, the row reads **Sign-in expired** with **Sign in**. A successful sign-in or a turn that works clears it.
  - Settings can't warn before the first failure; that would need a probe process on every machine.
  - A machine none of whose chats has run yet says "Not known yet" and still offers **Sign in**.
- **Chats with a `/loop` or running tasks (builder check, controller's call):** the restart after a sign-in waits as usual, except for chats whose last turn failed on login. Those can do nothing useful, so they restart without waiting. A loop held in that process is lost, and the chat says: "Restarted after signing in. Start `/loop` again if you need it." If the spike shows that live processes pick up the new login without a restart, nothing restarts at all.
- **One sign-in per machine at a time.** Starting another on the same machine replaces the first.
- **The error line.** A login failure gets its own words: "Claude Code isn't signed in on ‹machine›, or its sign-in expired." It replaces the raw text "Failed to authenticate…" and comes with the **Sign in to Claude** button. Builder's call: how a login failure is recognised (`authentication_failed`, `auth_status`, the result's error).
- **Which chats a switch restarts:** every live Claude chat on that machine, each between turns. A new process reads the new login.
- **The capability.** Machines that offer this have a capability (like `mcp`). An older machine shows its row without the buttons and says: "Update this machine to sign in from here."

## Left to the builder

- **Check first (spike):**
  - What does `claudeAuthenticate(true)` return: one address or two (an automatic one with a local callback, and a manual one)? What do `state` and the code look like?
  - Does the manual flow work on a machine without a browser, with the code pasted back?
  - Does it work in a process whose login has already failed?
  - Does `claudeOAuthWaitForCompletion` report success or failure?
  - Does `accountInfo()` show the new account right away?
  - Do other live processes keep the old token until they restart?

  If the controls don't hold up, stop and bring the `claude auth login`-in-a-PTY fallback back to the owner.
- **Which process runs the sign-in** when the machine has no live Claude chat. A short-lived process just for the sign-in (its own SDK query, closed afterwards) in the machine's home or default folder? Or the failed chat's process?
- **The protocol:** the method names, the capability name, and what the account row carries (email, organization, plan, API key).
- **The mock's fake sign-in,** for the UI and the e2e.
- **The phone layout** of the row and the dialog.
