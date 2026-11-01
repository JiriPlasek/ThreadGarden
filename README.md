<p align="center">
  <img src="docs/images/logo.png" alt="" width="80">
</p>

<h1 align="center">Threadgarden</h1>

<p align="center">A desktop app for your <a href="https://code.claude.com/docs">Claude Code</a> chats.</p>

Threadgarden shows every Claude Code conversation you've had on this machine, runs new ones in tabs, and tells you when an agent is waiting on you. Close the window and your agents keep going. Got an old PC lying around? It can do the work instead.

It runs your own `claude` install, with your own login, through the official Agent SDK. Not affiliated with Anthropic.

> Still early (0.3). Expect rough edges.

<!-- Screenshots will live in docs/images/. -->

## What's in it

- All your history in one place, grouped by project and searchable. File chats as Active, On hold or Archived so the list stays readable.
- Live chats in tabs, with proper rendering for code, diffs, todos and subagents. Permission prompts and questions are answered right in the chat.
- **Needs you** and **Running** lists across all projects, plus a tray badge and notifications, so you don't have to babysit tabs.
- Chats started in a terminal show up too.
- An activity panel to see what subagents and background processes are up to, and stop them.
- A usage meter for your plan limits, and "send when the limit resets" for that one message you'd otherwise forget.
- Remote machines: pair another computer on your network (an always-on Ubuntu box, say) and run chats there from the same window. See [docs/remote-machines.md](docs/remote-machines.md).
- Analytics, if you're curious where your tokens go.
- A quick switcher (Ctrl+K), shortcuts for everything, themes.

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

## Your data

Threadgarden never writes to `~/.claude`. It reads your history through the Agent SDK, and the only things that land there are Claude Code's own transcripts of the chats you run.

Its own data (a search index of your chats, your titles, drafts and settings) lives in `%APPDATA%\threadgarden`, `~/Library/Application Support/threadgarden` or `~/.local/share/threadgarden`. Delete the folder to start fresh. It holds the text of your chats, so treat it like `~/.claude`.

API keys and pairing tokens go to your OS keychain. The app itself only talks to localhost, your paired machines and GitHub (for updates); `claude` talks to Anthropic as it always does.

## Login and terms

There's no Threadgarden account. It uses whatever Claude Code uses: a subscription, an API key or a third-party provider. Anthropic's Agent SDK docs say third-party products shouldn't offer claude.ai login unless approved, and point to API keys instead. Whether your setup is fine is between you and Anthropic's terms, so give them a read (this isn't legal advice). There's also an API-key-only build, `THREADGARDEN_API_KEY_ONLY=1`. More in [docs/architecture.md](docs/architecture.md#authentication).

## Known limitations

- Tabs only: no split view, no embedded terminal.
- No `bypassPermissions`, and terminal-only commands like `/config` or `/login` don't work here.
- Chats running in another terminal are shown, not driven. You get a command to hand them over.
- After Claude Code compacts a chat, history starts at the compaction (that's all the SDK returns).
- Clicking a notification only focuses the window.
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
