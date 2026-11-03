# Move a chat: spike plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn whether the Agent SDK's session store can move a chat from This PC (Windows) to the Ubuntu PC and back with its whole history, before any of Move to… is built.

**Architecture:** One throwaway CLI script, `spikes/move-session/spike.ts`, is bundled with esbuild into a single `spike.mjs`, the way the service is bundled. It runs with plain Node on either machine:
- `seed` makes a test chat;
- `export` reads a session into an in-memory store and writes it to a JSON file;
- `resume` loads that file into a store and resumes the chat in another folder, logging every key the SDK asks for.

The file is copied between machines by hand (`scp`). The results go into a short results document for the owner.

**Tech Stack:** Node 22, `@anthropic-ai/claude-agent-sdk` 0.3.314 (already a service dependency), esbuild.

**Spec:** `docs/superpowers/specs/2026-11-02-move-chat-design.md` (§5 "Spike first", "What the spike must show"; §6 round trip).

## Global Constraints

- The spike's own code never writes, renames or deletes anything under `~/.claude` (the hard rule). Claude Code writing its own transcript while a resumed chat runs is normal operation and allowed.
- Use the SDK's official API only: `importSessionToStore`, `query({ resume, sessionStore, cwd })`, `listSessions`, `getSessionMessages`. Never read or copy `.jsonl` files directly.
- Always pass `pathToClaudeCodeExecutable` (the installed `claude`), as the service does. The bundle has no bundled CLI.
- Throwaway code: no tests and no protocol changes. It lives under `spikes/` and is deleted before the build plan's branch merges.
- Steps marked **(owner)** run on the Ubuntu PC over SSH or in the Threadgarden app. The agent gives the exact commands and the owner pastes back the output.
- Every Claude turn the spike runs is one short turn: no tools on resume, and a single prompt each time.

## Review Focus

- A `projectKey` the SDK asks for on the target that differs from the source's, which the store must still answer. `resume` logs every key, so the results show which one was asked.
- A session id that changes on resume. The results record the id before and after, because the build re-keys tabs, Needs you entries and scheduled sends if it changes.
- Subagent transcripts missing on the target. The results record whether `listSubkeys` was called and what came back.
- A round trip that duplicates or clashes with the old transcript. The results record what `listSessions` shows on This PC afterwards.
- A chat that resumes but renders badly in Threadgarden: tool rows, the subagent row. The owner checks it in the app.

---

### Task 1: The spike tool, proven on This PC alone

**Files:**
- Create: `spikes/move-session/spike.ts`, `spikes/move-session/build.mjs`, `spikes/move-session/README.md` (the commands of tasks 2–4, copy-paste ready)
- Modify: `.gitignore` (add `spikes/move-session/dist/`)

**Interfaces:**
- Produces: the CLI `node spikes/move-session/dist/spike.mjs <command> …`:
  - `seed --cwd <dir> --claude <path>`: runs one chat in `<dir>` with the prompt below. It prints `session <id>`.
  - `export <sessionId> --dir <cwd> --out <file>`: `importSessionToStore(id, memoryStore, { dir, includeSubagents: true })`. It then writes `{ sessionId, sourceDir, keys: [{ key: SessionKey, entries: SessionStoreEntry[] }] }` to `<file>` and prints the entry count per key.
  - `resume <file> --cwd <dir> --claude <path>`: a store that answers `load` and `listSubkeys` for **any** `projectKey`, matching on `sessionId` and `subpath`. It logs each call as `load {projectKey, sessionId, subpath}` and ignores `append`. It runs `query({ prompt: RESUME_PROMPT, options: { resume, sessionStore, cwd, pathToClaudeCodeExecutable, maxTurns: 1, allowedTools: [] } })` and prints:
    - the init message's `session_id`;
    - Claude's reply;
    - then `listSessions({ dir: cwd })` (each id and title) and the `getSessionMessages` count for the resumed id.

  The seed prompt, verbatim: `Spike seed. 1) Read README.md and tell me its first line. 2) Use a subagent (Task tool) to list the files in this folder. 3) Remember this word for later: ORNN-FORGE. Reply briefly.` (`seed` runs with `allowedTools: ['Read', 'Glob', 'LS', 'Task']` in its scratch folder only, so it doesn't stop on prompts. It never uses a bypass permission mode, and never runs in the owner's repos.)

  The resume prompt, verbatim: `Spike check, no tools: in one line, what word did I ask you to remember, and what did the subagent find?`

- [ ] **Step 1: Write `build.mjs`.** It copies the service's esbuild settings (`packages/service/scripts/build.mjs`): bundle, `platform: 'node'`, `format: 'esm'`, `target: 'node22'`, the same `createRequire` banner, entry `spike.ts`, out `dist/spike.mjs`.
- [ ] **Step 2: Write `spike.ts`** with the three commands above (`node:util` `parseArgs`). It exits non-zero with the error text on any failure.
- [ ] **Step 3: Build it.** Run `node spikes/move-session/build.mjs` from `packages/service`, so esbuild and the SDK resolve. Expected: `spikes/move-session/dist/spike.mjs` exists.
- [ ] **Step 4: Seed a test chat on This PC.** Make the scratch folder `C:\tmp\tg-move-spike` with a `README.md` whose first line is `tg move spike` and `git init` it. Then run `seed --cwd C:\tmp\tg-move-spike --claude <This PC's claude.exe>`. Expected: `session <id>`, and a reply naming `tg move spike`, the file list and ORNN-FORGE.
- [ ] **Step 5: Export it.** Run `export <id> --dir C:\tmp\tg-move-spike --out C:\tmp\tg-move-spike.json`. Expected: one key with no `subpath` (the main transcript) and at least one `subagents/…` key.
- [ ] **Step 6: Resume it on This PC in another folder** (`C:\tmp\tg-move-spike-b`, a fresh `git init`). Run `resume C:\tmp\tg-move-spike.json --cwd C:\tmp\tg-move-spike-b --claude …`. Expected:
  - a reply with ORNN-FORGE and the file list;
  - the logged `load` keys, recording which `projectKey` was asked;
  - whether `listSubkeys` was called;
  - the session id before and after.

  If this fails, the cause is in the tool or the API, not the platforms. Stop and record it.
- [ ] **Step 7: Commit.**

```bash
git add .gitignore spikes/move-session
git commit -m "spike: move a chat through the SDK session store"
```

### Task 2: Windows → Ubuntu PC (owner)

**Interfaces:**
- Consumes: `dist/spike.mjs` and `C:\tmp\tg-move-spike.json` from Task 1.

- [ ] **Step 1: Copy both files to the Ubuntu PC** (owner, from This PC's terminal): `scp spikes/move-session/dist/spike.mjs C:\tmp\tg-move-spike.json kumbal@192.168.1.101:~/`. The user name is whatever the owner uses for SSH.
- [ ] **Step 2: Make the target folder** (owner, over SSH): `mkdir -p ~/threadgarden/projects/tg-move-spike && git -C ~/threadgarden/projects/tg-move-spike init`.
- [ ] **Step 3: Resume there** (owner), with the headless service's own Node:

```sh
~/.local/share/threadgarden-headless/current/bin/node ~/spike.mjs resume ~/tg-move-spike.json --cwd ~/threadgarden/projects/tg-move-spike --claude ~/.local/bin/claude
```

  Expected: the reply names ORNN-FORGE and the subagent's file list (**the must-pass check**). The owner pastes back the whole output: the `load` keys, `listSubkeys`, the id before and after, and `listSessions`.

### Task 3: It renders in Threadgarden (owner)

- [ ] **Step 1:** In Threadgarden on This PC, open kumbal-machine's `tg-move-spike` project. Expected: the resumed chat is listed. It's under the resumed id from Task 2, if that changed.
- [ ] **Step 2:** Open it. Expected:
  - the whole conversation shows: the seed prompt, the Read tool row, the subagent row with its result, and the spike check with its reply;
  - nothing shows as broken or empty.

  The owner sends a screenshot.

### Task 4: The round trip back to This PC

- [ ] **Step 1: Export on the Ubuntu PC** (owner): `…/bin/node ~/spike.mjs export <resumed id> --dir ~/threadgarden/projects/tg-move-spike --out ~/tg-move-spike-back.json`, then `scp` it to `C:\tmp\` on This PC.
- [ ] **Step 2: Resume on This PC into the original folder** (agent): `resume C:\tmp\tg-move-spike-back.json --cwd C:\tmp\tg-move-spike --claude …`. Expected:
  - a reply with ORNN-FORGE;
  - `listSessions({ dir: C:\tmp\tg-move-spike })` shows one chat or two (record which);
  - the `getSessionMessages` count matches the Ubuntu side plus the new turn.
- [ ] **Step 3:** In Threadgarden, open This PC's `tg-move-spike`. Expected: record whether it shows one chat with the whole history or two chats. A screenshot if it's unclear.

### Task 5: Results to the owner

**Files:**
- Create: `docs/superpowers/specs/2026-11-02-move-chat-spike-results.md`

- [ ] **Step 1: Write the results.** One line per spec §5 check (pass, fall short or fail, with the evidence), then the path the build will take per "What the spike must show":
  - full history;
  - full history with stated gaps;
  - or the summary handoff.

  Record the `projectKey` the store must answer, whether the session id changes, and the round-trip outcome for §6.
- [ ] **Step 2: Commit** (`docs: move-chat spike results`), then tell the owner. Per spec §5, nothing is built until the owner has seen the results. The build plan comes next.
- [ ] **Step 3: Tidy up.** Delete `C:\tmp\tg-move-spike*` on This PC. The owner deletes `~/spike.mjs`, `~/tg-move-spike*.json` and `~/threadgarden/projects/tg-move-spike` on the Ubuntu PC. The test chats stay in Claude Code's history like any chat. Threadgarden never deletes them, and the owner can hide them.
