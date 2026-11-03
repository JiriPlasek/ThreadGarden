# Move a chat to another machine: design

Date: 2026-11-02. Owner: Jiří Plášek. The last item of remote machines plan 2. It refines §8 and §9 of [the remote machines design](2026-10-31-remote-machines-design.md). Where the two differ, this document wins.

## 1. Why

The owner works with chats on two machines: This PC (Windows) and the Ubuntu PC (`kumbal-machine`, headless). They have not needed a move yet, but expect it to be useful to switch the machine a chat runs on now and then. For example, a long task is handed over to the Ubuntu PC so This PC can be turned off, or a chat is brought back to This PC to carry on there.

**Success:** from a chat, the owner picks **Move to… → kumbal-machine**. The chat carries on there with its whole conversation, so Claude remembers everything. Nothing left on the old machine is lost without the owner knowing.

## 2. Decisions (owner)

- **Git work is the chat's job, not Threadgarden's** (2026-11-02): "worktrees and pushing and stuff like that can be handled in the chat directly, we dont need to build some sort of feature for that".
  - So Threadgarden does not clone, fetch, check out or push for a move.
  - Getting the repo ready on the target is Claude's work: cloning it if it is missing, then checking out the chat's branch.
  - This replaces the git writes in the old design's §8 ("Working copies on This PC", "Clone from This PC's project" during a move, the worktree rule) and §9 step 2. The standing "push your work" instruction (§8 "Pushing") is dropped as well.
- **Unpushed work stops the move and the owner decides.** If the chat's project on the source machine has uncommitted changes or unpushed commits, the move does not go ahead on its own.
- **Both directions:** This PC → Ubuntu PC and back. The playback below was approved as a whole ("lgtm"):
  - the three checks before a move (§3);
  - the three choices when the project isn't clean (§3);
  - the move through the SDK session store, with a throwaway spike first and a summary handoff as the fallback (§5);
  - Claude's first note on the target (§4);
  - the old copy kept read-only and hidden (§6).

## 3. Before anything moves

**Where it starts:** **Move to…** in the chat header, the chat row's menu and Ctrl/Cmd+K, as the old design planned (§7). It opens a small dialog with these parts:
- the target machine: every paired machine except the chat's own, This PC included;
- the folder the chat will use there (§4);
- the result of the checks below.

**The checks, in this order:**
1. **The chat isn't busy.** A chat that is mid-turn, waiting on a permission prompt or a question, or has background subagents running cannot move. The dialog says why and offers **Stop the chat** (the existing stop) or to wait. *(designer's call: a prompt or a subagent counts as busy, because moving would cut it off)*
2. **The project on the source machine is clean.** This means no uncommitted changes (untracked, non-ignored files included) and no commits on the current branch that its upstream lacks. A branch with no upstream counts as unpushed if it has any commits that are on no remote branch. When the project isn't clean, the dialog lists what would stay behind, for example "3 changed files · 2 commits not pushed on `fix/usage`", and offers:
   - **Ask Claude to commit and push.** It sends that request as a message in the chat and closes the dialog. The owner moves again when it's done. The message names the branch and says the owner may want a WIP branch. *(designer's call for the wording)*
   - **Move anyway.** The changes stay on the source machine. Claude's first note on the target says what was left behind and where (§4).
   - **Cancel.**

   A folder that isn't a git repo has nothing to check here, but its files can't come along either. The dialog says so: "This folder isn't a git repo; its files stay on This PC". It then offers Move anyway and Cancel. *(designer's call)*
3. **The target machine is on.** If it is Off, the move turns it on (as sending a message does today) and carries on when it connects. The dialog shows "Starting kumbal-machine…". If it is Unreachable or doesn't come up, the move fails with nothing changed.

**Reading the git state is read-only** (`git status`, `git rev-list`, and so on, on the source machine through its service). This is the only git Threadgarden runs for a move.

## 4. The chat on the target machine

**The folder there** *(designer's call)*:
- If the target already has a project whose `origin` matches the chat's project, the chat uses that folder. This is the same matching as Clone's "on This PC" mark.
- Otherwise it uses `<Create in>/<repo name>`, where Create in is the place New chat remembers for that machine. The folder doesn't exist yet; Claude clones into it. Threadgarden creates the chat's empty folder if it is missing (Claude Code starts in it), the same folder making New project already does.
- If the target has several folders of that repo (a clone and its worktrees), it prefers the one that has the chat's branch checked out. Next comes a clean one with no live chat. *(designer's call)*
- **The chat's branch** is the branch checked out in the chat's folder on the source at the time of the move. Check 2 inspects that branch. *(designer's call)*
- The dialog shows the chosen folder and lets the owner change it with the same Browse… as New chat.
- **A folder in use** *(designer's call)*: the matching folder may be on another branch while other chats use it (on This PC it is the owner's own working copy). In that case the dialog says so, for example "kumbal-machine's threadgarden is on `main`; 1 chat is running there". It suggests picking another folder or moving anyway. The first note then tells Claude to stop and ask instead of switching branches under another chat. Claude never makes a worktree on its own for a move: the chat's folder is fixed when it resumes, so a worktree made later would leave the chat pointing at the wrong place. If the owner wants a worktree, they make it first (in any chat) and pick it with Browse….

**Claude's first note.** As soon as the chat has resumed on the target, Threadgarden sends one message in it, shown in the chat as sent by Threadgarden, and Claude acts on it straight away. *(designer's call: the repo is then ready by the time the owner looks again; it uses one turn of the target machine's limits.)* It says:
- the chat was moved from ‹source› to ‹target›, and the folder it now works in;
- the repo (`origin` URL) and the branch the chat was on;
- to make the repo ready: clone it into that folder if it is missing, then fetch and check out the branch;
- on a working copy that already has uncommitted changes, or one on another branch that other chats use: never stash, reset, overwrite or switch it; stop and ask the owner instead. This carries the old design's "only if clean" rule for This PC, now as an instruction;
- after Move anyway: what was left behind on ‹source›, so Claude doesn't assume it is there.

The exact wording is the builder's, but it must carry these facts.

**Where it shows:** the chat appears under the target machine's group, in its project, and its tab follows it. Needs you, Running and scheduled sends follow the chat to its new machine. A scheduled send that was waiting on the source moves with it. *(designer's call: what's scheduled belongs to the chat)*

## 5. How the conversation moves

**Through the Agent SDK's session store, never a file copy.** Threadgarden never writes under `~/.claude` and does not depend on Claude Code's transcript format. The installed SDK (0.3.314) has the official, **alpha** path:
1. On the source, `importSessionToStore(sessionId, store, { includeSubagents: true })` reads the session into a store that Threadgarden implements in memory. Its entries are sent to the target over the protocol.
2. On the target, the chat resumes with `query({ resume: sessionId, sessionStore, cwd: <target folder> })`. Claude Code writes its own transcript there as usual.

**Spike first.** Before any of the move is built, a throwaway spike checks these on the owner's two real machines:
- a session started in a Windows folder resumes on Linux in a different folder, including which `projectKey` the store must answer for;
- subagent transcripts come along;
- tool history renders in Threadgarden on the target;
- the resumed session appears in `listSessions` on the target, and whether it keeps its session id;
- **the round trip:** This PC → Ubuntu PC → This PC, back into the same folder. Does the returning chat resume cleanly next to its old transcript, without clashing with it or duplicating it?

**What the spike must show** *(designer's call)*:
- **Must pass:** the main conversation resumes on Linux in a different folder with its whole message history, and renders in Threadgarden. Without this, the move is the summary handoff below.
- **May fall short:** missing subagent transcripts, a changed session id, or a failed round trip. These weaken the full-history move but don't replace it:
  - Missing subagents: the owner is told before confirming ("subagent details stay on This PC").
  - A changed id: the client re-keys the chat's tab, Needs you entry and scheduled sends to the new id.
  - A failed round trip: see §6.
- **After the spike, the results go to the owner** before either path is built, with the path the build will take.

**Fallback if the must-pass check fails: a summary handoff.**
- Claude summarises the conversation on the source.
- The target starts a new chat seeded with that summary and with the first note from §4.
- The new chat links to the old one ("Continued from This PC").
- The owner is told before confirming that the move will carry a summary, not the full history.

**Size:** if a session's entries are too large for one protocol message, the builder chunks them. A move of a very long chat must not fail for its size alone. *(builder's call)*

## 6. The old copy and failures

- **The old copy stays on the source machine,** read-only and hidden from its lists. Threadgarden keeps its own record that it moved and where to; Claude Code's files are untouched. Opening it, for example from an old link or search, shows it read-only with "Moved to kumbal-machine" and a link to the chat there. *(designer's call, from the old design §13)*
- **Moving back to a machine that holds the old copy** *(designer's call)*: the return gives **one chat**. The returning chat takes over the old copy, which stops being "moved", and the machine that had it until now keeps its own read-only copy instead. If the spike shows Claude Code can't resume cleanly next to the old transcript, the return makes a separate chat. The old copy then stays hidden, and the owner is told before confirming.
- **A move that fails** at any step before the target has resumed leaves the chat where it was, unchanged and usable, with the reason shown in the dialog. Once the target has resumed, the move counts as done: if the first note then fails to send, the chat on the target says so and the owner can retry it. *(designer's call)*
- **No automatic moves.** A move happens only when the owner asks for it.

## 7. Protocol and compatibility

- A move needs both services on the new protocol version, so it bumps the protocol, and the Rust copy of the version moves too.
- Move to… offers only machines whose service supports it. An older machine is listed as "Update ‹machine› to move chats there".
- Updating the Ubuntu PC stays manual until plan 3.

## 8. Not in this step

- Threadgarden doing any git work: clone, fetch, checkout, push or worktrees. That is the chat's job (§2).
- Carrying uncommitted changes across machines.
- Moving several chats at once, or a whole project.
- Moving between two remote machines without This PC. It isn't excluded by design, but only This PC ↔ Ubuntu PC is tested.
