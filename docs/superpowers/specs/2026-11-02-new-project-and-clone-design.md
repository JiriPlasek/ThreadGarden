# New project, Clone and Browse in New chat: design

Date: 2026-11-02. Owner: Jiří Plášek. Part of remote machines plan 2 (the first item). It refines §7 and §8 of [the remote machines design](2026-10-31-remote-machines-design.md). Where the two differ, this document wins.

## 1. Why

During the 0.4.0 hardware test the owner wanted to start a brand-new project on the Ubuntu PC (`kumbal-machine`). New chat on a remote machine offers only that machine's projects and its Home folder. **Choose folder…** is the native picker, which works on This PC only. So there was no way to browse, type a path or create anything. The owner had to start a chat in Home and ask Claude to make the project folder, then start another chat there.

Success: from the desktop, without SSH, the owner can do any of these on any machine and land in a chat:
- start in any existing folder;
- start a new project (optionally with its GitHub repo);
- clone any repo the machine's GitHub account can reach.

## 2. Decisions (owner)

- **Tabs.** The New chat dialog asks first what you are starting, with three tabs under the Machine select: **Existing folder** · **New project** · **Clone** (layout B, chosen from mockups over one dialog with an inline section).
- **Choose the place each time when needed.** The owner can browse or type a different place for each project. One fixed projects folder per machine is not enough.
- **Clone takes anything the machine's connected GitHub account can reach.** It is not limited to This PC's projects or to a pasted link.
- The owner approved the full proposal as played back:
  - the Existing folder tab with Browse…;
  - the New project tab with Create in and the optional GitHub repo;
  - the Clone tab with the account's repo list;
  - the folder browser;
  - the guesses marked in §3 to §6.

## 3. Existing folder tab

- It keeps today's folder select: that machine's projects (pinned, then most recent), plus its Home folder on another machine.
- **Browse…** next to it:
  - **On This PC** it opens the native folder picker, as today.
  - **On another machine** it opens the folder browser (§6).
- The first message is written in the composer below the tabs, as today. Model and Permission mode stay as they are, and stay shared by all three tabs.

## 4. New project tab

**Fields**
- **Name:** the folder's name, and the repo's name if one is created. It allows the characters a GitHub repo name allows (`A-Za-z0-9._-`, not `.` or `..`, at most 100 characters). An invalid name shows why under the field.
- **Create in:**
  - A path you can type, or pick with **Browse…** (the native picker on This PC, the folder browser elsewhere).
  - It is remembered per machine: the last place used on that machine.
  - The first time on a headless machine, it is `~/threadgarden/projects` (made when first used).
  - The first time on This PC, it is the folder holding the most recently active project; with no projects, it is the home folder *(designer's call)*.
- **Create a GitHub repo:** a tick, off by default *(designer's call)*. When ticked, the repo is created private on the account signed in to `gh` on that machine.
- **Preview:** a line under the fields shows the full path that will be created.

**What happens on Start** (sending the first message)
1. **Checks:**
   - Create in must exist, or be creatable as one new chain of folders under the home folder.
   - The target folder must not exist yet. If it does, stop and say so: "plant-logger already exists in ~/code. Use the Existing folder tab to start there."
   - With the tick, the repo name must be free on the account.
2. **Setting up:** make the folder and run `git init`. With the tick, create the private repo and set it as `origin`. Nothing is pushed: the repo is empty until Claude's first push.
3. **The chat starts** in the new folder with the first message, and opens in a tab, like any new chat.

**When a step fails** *(designer's call)*:

- **Check first.** Everything that can be checked runs before anything is made: Claude Code is runnable on that machine, the folder can be made, and with the tick the repo name is free.
- **Before the repo exists:** if the folder, `git init` or the repo creation fails, Threadgarden removes the new, still-empty folder it just made. It shows the error in the dialog, keeping the typed message and fields, so the owner can fix it and try again.
- **After the repo exists:** if setting `origin`, the chat start or the connection fails, nothing is removed or deleted, neither the folder nor the GitHub repo. The dialog says the project is ready ("plant-logger was created, but the chat didn't start: ‹reason›") and offers **Start there**. That switches to the Existing folder tab with the folder selected and the message kept.
- Threadgarden never deletes a GitHub repo, and never removes a folder it did not make.

## 5. Clone tab

- **The list:**
  - It holds every repo the account signed in to `gh` on the chosen machine can reach: your own repos, your organizations' repos, and repos you collaborate on.
  - Sorted by last updated, with a search box that filters by owner/name.
  - Each row shows `owner/name`, a private or public mark, and when it was last updated.
  - A repo that is already a project on This PC carries a small "on This PC" mark (matched by its `origin` URL).
- **Create in:** the same field as New project, sharing its remembered place. The clone goes into `<Create in>/<repo name>`.
- **Branch:** the repo's default branch. Other branches are Claude's job in the chat (or plan 2's worktrees later).
- **Already there:** if `<Create in>/<repo name>` already exists and is a clone of the same repo, the tab offers **Start there** instead of cloning again. If it exists and is anything else, the tab stops and says so.
- **Progress:** cloning can take a while. The dialog shows "Cloning owner/name…" and Cancel. On success the chat starts in the clone with the first message. A failed or cancelled clone removes the partial folder, which Threadgarden made. If the clone succeeds but the chat doesn't start, the clone is kept and **Start there** is offered, as in §4.
- **`gh` not ready on that machine:** this covers `gh` missing, not signed in, or unable to read its keyring (seen during the Ubuntu setup). The tab shows no list. It says what is wrong and what to run there, for example "Run `gh auth login` on kumbal-machine (over SSH)". New project's GitHub tick is disabled with the same reason; the rest of New project still works.
- **This PC:** the same tab, using This PC's `gh`. Without `gh` it says so, as above.

## 6. The folder browser

It is used for Browse… on any machine except This PC, and for Create in's Browse… there.

**Layout**
- **A path box** at the top. You can type any absolute path, and `~` means that machine's home. Tab completes the folder name, and Enter goes there.
- **A breadcrumb**, then the folders in the current folder, with `..` first.
  - Only folders are shown, sorted by name.
  - Hidden folders (starting with `.`) are left out unless you type them.
  - Folders that are git repos carry a "git" mark.
- **New folder** makes a folder in the current one.
- **Use this folder** returns the current folder. **Cancel** closes the browser.
- It opens on the field's current value, else the machine's home folder.

**Errors** are shown in place, for example "No such folder" or "Permission denied". The browser stays usable.

**Who may use it:** the owner's own desktop (local) and paired devices, like every other remote method. It lists folder names only, never file contents.

## 7. Behind the dialog (for the builder)

**New service methods** (names are *(builder's call)*):
- list a folder's subfolders (with the git mark) and complete a partial path;
- make a folder;
- create a project (folder, `git init`, optional repo);
- list the account's GitHub repos;
- clone a repo (with progress and cancel);
- read and write the remembered Create in.

All of them run on the chosen machine's service: locally for This PC, through the relay for another machine.

**GitHub** goes through the machine's own `gh`, so it acts as whatever account is signed in there. Threadgarden stores no GitHub token. How the repo list is fetched (`gh api` with pagination, `gh repo list`) is *(builder's call)*. It must include organization and collaborator repos.

**Protocol:** this is version 7.
- A desktop on 7 still talks to a machine on 6 (the remote range is 5 to 7). There, **Browse…** on another machine and the **New project** and **Clone** tabs are disabled with "Update kumbal-machine to use this". Updating stays a manual step until plan 3.
- The capability that marks support is *(builder's call)*: the base design names it `remoteProjects`.

**Writes on This PC:** New project and Clone create new folders and run `git init` or `git clone` in them. Those are new writes on This PC, alongside the ones the base design allows. architecture.md's note on git access is updated to say so. Threadgarden still never changes a folder it did not create.

**A record of what Threadgarden made** *(designer's call)*: each machine's service keeps a small, durable list of the folders it created with New project or Clone. Each entry holds the path, the repo (if any) and when it was made. This step only writes the list. Later plan 2 items, worktrees and Move to…, use it to tell a working copy Threadgarden made from the owner's own folder. Base §8's freedom to "clone, fetch and check out freely" applies only to folders on that list. Every other folder gets the This PC rule: only when clean.

The new project shows up in the machine's project list as soon as its first chat exists, as today. No separate "project without chats" state is needed.

## 8. Changes to the base design

- **Projects folder (§8):** the fixed, configurable projects folder in Settings is replaced by Create in, remembered per machine. Its default is the same `~/threadgarden/projects` on headless machines.
- **"From This PC's projects…" (§7, §8):** this is covered by the Clone list, where This PC's repos are marked. It clones the default branch, not the branch checked out on This PC. Moving a chat with its branch stays with Move to… (§9).
- **New repos:** they stay private by default. Creating one is opt-in, through the tick.

## 8a. Also in this step: the place jumps to Needs you (bug, owner)

**What the owner saw:** "Active" was selected. A chat in another tab notified that it needed the owner. The owner clicked that tab in the tab bar, and the places column switched from Active to Needs you. That is unwanted: the owner chose Active, and a tab click must not change it.

**Likely cause** (to be confirmed with a failing test first): when the window regains focus within a short time after a notification, `openNotified` in `apps/desktop/src/lib/notifications.ts` selects Needs you. It skips that only when every notification was about the tab already active at that moment. The owner's click on the tab arrives after the focus, so the place has already moved.

**What the owner saw, more precisely** (2026-11-02): Threadgarden was behind another window, showing a different chat's tab. A notification said a chat needed the owner. The owner clicked Threadgarden to bring it to the front, and both the place and the tab switched.

**Wanted behaviour** *(owner's intent, mechanism the designer's call)*: coming back to the window changes nothing. Neither the selected place nor the open tab moves; the owner's chosen place and tab stay until they choose others. The "open what the notification was about when the window regains focus soon after it" heuristic is removed entirely: the app can't tell a click on the notification from any other way of coming back. The notification itself, the Needs you count and the tray badge still say what is waiting.

## 8b. Also in this step: the window's update loop (bug, owner)

**What the owner saw:** "Something went wrong" with `https://svelte.dev/e/effect_update_depth_exceeded`. 0.4.1 logged it in service.log at 2026-11-02 01:23:31 as `ui (navigation)`, with a minified stack. This is the old "500 Internal Error". All three times it happened right after the owner sent a message in a very long This PC chat, once while the turn was still running.

**Likely cause** (to be confirmed with a failing test first): the measuring effect in `apps/desktop/src/lib/components/chat/MessageList.svelte` handles a row whose measured height differs from its estimate. It bumps `version` and returns without calling `reposition()`.
- The offsets move under an unchanged `scrollTop`, so the visible range drifts onto unmeasured rows.
- Those rows get measured too, which drifts the range again.
- In a chat with thousands of rows this can take more than Svelte's 1,000 updates in one flush.

**Wanted behaviour** *(designer's call on mechanism)*: measuring keeps the view where it was (stuck to the bottom, or on the anchored row), and the list settles within a few rounds whatever the chat's length. As a safety net, a measuring pass that keeps changing heights past a small bound finishes on the next frame instead of in the same flush. A very long chat never brings up the error screen.

## 9. Not in this step

- Worktrees, the "push your work" instruction, Move to…, and switching branches on This PC. These are the later plan 2 items.
- Choosing a branch to clone, templates or starter files, and installing dependencies. Dependencies stay Claude's job in the chat.
- Hosts other than GitHub, and pasting arbitrary git URLs.
- Deleting or renaming projects or folders from Threadgarden.
- Showing files in the folder browser.

## 10. Anti-goals

- Threadgarden must never touch a folder it didn't create: no overwrite, no clone into a non-empty folder, no cleanup of a folder it didn't make.
- No GitHub token is kept by Threadgarden, and no OAuth flow of its own.
- Starting a project must not need SSH, unless `gh` itself needs signing in on that machine.
