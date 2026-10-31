# Release checklist

Manual checks before calling a build ready. Automated tests cover the service,
the UI against a mock service and the release build on all three platforms;
these checks cover what only a person at the machine can see. Run them on an
installed build (not `tauri dev`), signed in to Claude Code, on each OS you
can test. Record the OS, the build (commit or CI run) and the result of each
check in the pull request or release notes.

## Before you start

- [ ] Build or download the installer for the commit under test
      (see the README's Install section) and install it.
- [ ] Run `pnpm --filter @threadgarden/service test:real` on the same machine and
      keep its output.
- [ ] Have at least one Claude Code session running in a terminal, and one
      background session (`claude --bg …`) waiting on a permission prompt.

## Launch and history

- [ ] First launch with no service running: the window shows the chat list
      within about 2 s; history from every project appears (indexing may
      continue in the background; Settings shows progress).
- [ ] Quit Threadgarden (keep agents running), launch again: the list is visible
      within about 800 ms.
- [ ] Open an old chat: it renders within a moment, scrolls smoothly, and
      Ctrl/Cmd+K finds it by title and by a phrase from its text.

## Chats

- [ ] Start a new chat in a project and run a turn end to end; a tool call
      that needs permission shows the card; Allow, Deny and Always allow work.
- [ ] Ask a question that makes Claude use AskUserQuestion, and one in plan
      mode: the question form and the plan approval work.
- [ ] Send a message while Claude is working: it is queued and sent next.
- [ ] Type `@` and pick a file; the reply shows Claude saw the file.
- [ ] Type `/`: commands from Claude Code are listed; `/model` opens the
      model picker; `/config` is shown as unavailable.
- [ ] **File drop:** drop a PNG on the composer (it is attached), drop a text
      file (it becomes an `@` mention), drop a file elsewhere on the window
      (nothing navigates away).
- [ ] **Links:** click a link in a reply: it opens in the system browser, not
      inside Threadgarden. A remote image in a reply shows as a link.
- [ ] End session, then send again: the chat resumes with its history.
- [ ] Fork from a user message: a new chat opens with the conversation up to
      that message; the original is unchanged.

## Window, tray and service

- [ ] **Tray menu:** "Open Threadgarden", "Stop all work…" (confirms, stops every
      Threadgarden chat), "Quit Threadgarden (keep agents running)", "Quit Threadgarden
      completely…" (confirms, lists running agents, exits and stops the
      service) all do what they say. The tray tooltip (and title on macOS and
      Linux) shows the needs-you count.
- [ ] Close the window while a chat is working: the chat keeps running; open
      Threadgarden from the tray and it shows the finished turn.
- [ ] **Windows:** end Threadgarden with Task Manager → "End task" while a chat is
      working. The agent keeps running (the `pahub-node` service process
      survives); launching Threadgarden again reconnects to it. On macOS and Linux,
      kill the app process (`kill <pid>`) and check the same.
- [ ] **Notifications:** with the window unfocused or another chat active,
      a chat that needs you posts a notification. Clicking it focuses Threadgarden
      and opens Needs you (and the chat, when it is the only one waiting).
      Turning notifications off in Settings stops them.
- [ ] **Restart-service banner:** with an older service still running
      (install the previous build, start a chat, quit keeping agents running,
      install the new build, launch it), Threadgarden shows the "older version" bar;
      **Restart service** lists the running agents, restarts, and reconnects.
- [ ] After a reboot (or killing the service process), chats that were
      running show as interrupted and resume in one click.

## External sessions

- [ ] The terminal session and the background session appear in the list
      with the terminal marker; the waiting background session shows under
      Needs you and in the running-agents strip.
- [ ] Open an external session: its history is read-only; the copy actions
      give `claude --resume <id>` / `claude attach <id>`.
- [ ] **Resume blocked:** "Continue in Threadgarden" on the session still running in
      the terminal is refused with an explanation. After exiting that
      terminal session, continuing it works.

## Settings and data

- [ ] Set an API key: the chat header of a new chat shows API-key
      authentication; remove it and the next new chat shows the inherited
      authentication again. The key is in the OS credential store under
      `pahub`, and not in the data dir.
- [ ] Theme (system/light/dark), Enter-to-send and start-on-login settings
      take effect and survive a restart.
- [ ] A draft typed in a chat survives quitting and relaunching Threadgarden.
- [ ] Uninstall Threadgarden and delete its data dir: Claude Code in a terminal
      still lists and resumes every session as before.
