# New project, Clone and Browse in New chat: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the desktop, without SSH, the owner can start a chat on any machine in three ways: in any folder (browsed or typed), in a new project (optionally with a private GitHub repo), or in a clone of any repo the machine's GitHub account can reach. Two bugs found during the 0.4.x hardware test are fixed along the way.

**Architecture:**
- **The service.** Each machine's service gains a small `projects/` module that does the work:
  - `folders.ts`: list, complete and make folders;
  - `github.ts`: drives the machine's own `gh` and `git`;
  - `maker.ts`: creates projects and runs clone jobs, remembers Create in, and records what it made.
- **The protocol.** New methods are open to paired devices like the rest. Protocol 7 adds the `projects` capability, so a desktop can tell an older remote apart.
- **The desktop.** The New chat dialog becomes three tabs: Existing folder · New project · Clone. A folder browser component stands in for the native picker on other machines.

**Tech Stack:**
- TypeScript, zod (`@threadgarden/protocol`);
- Node 22 `node:fs/promises` and `node:child_process` `execFile`/`spawn` (service);
- SvelteKit 5 runes, Testing Library and vitest (desktop).

**Spec:** `docs/superpowers/specs/2026-11-02-new-project-and-clone-design.md`. It refines `docs/superpowers/specs/2026-10-31-remote-machines-design.md` §7 and §8.

## Global Constraints

**Environment**
- Agent environment: run pnpm as `pnpm --config.verify-deps-before-run=false …`. Processes here can't follow symlinks; dependencies are the hoisted, copied install. Never run a bare `pnpm install`.
- Test commands:
  - `pnpm --config.verify-deps-before-run=false --filter @threadgarden/protocol test`
  - `pnpm --config.verify-deps-before-run=false --filter @threadgarden/service test -- <path>`
  - `pnpm --config.verify-deps-before-run=false --filter desktop test -- <path>`
- Finish every task with `typecheck` and `lint` clean for the packages it touched.

**Protocol**
- `PROTOCOL_VERSION = 7`.
- The remote range is the desktop's own version, one older and one newer: `{ min: 6, max: 8 }`.
- The capability is `PROJECTS_CAPABILITY = 'projects'`, added to `CAPABILITIES`, so every 0.5 service reports it.

**Paths and names**
- The default Create in on a headless machine is `~/threadgarden/projects`, created when first used.
- The default Create in on a desktop (non-headless) machine is the parent of the most recently active project's folder (`recentCwds()[0]`), else the home folder.
- Name rule (GitHub's): `/^[A-Za-z0-9._-]{1,100}$/`, and not `.` or `..`.
- Paths are built and resolved **only by the service** of the machine they live on: `path.resolve`, `path.dirname`, `~` → `os.homedir()`. The desktop never joins or splits a remote path, because the machine may be Windows or Linux.

**GitHub and git**
- Threadgarden stores no GitHub token. `gh` and `git` always run with env `GH_PROMPT_DISABLED=1`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, with `windowsHide: true` and a timeout. They never wait on a prompt.
- New repos are created `--private`.

**Safety**
- Threadgarden never removes a folder it didn't make in the same call or job, and never deletes a GitHub repo.
- Permission modes stay as they are: never `bypassPermissions`.

**Copy (exact)**
- Tab names: `Existing folder`, `New project`, `Clone`.
- Buttons: `Browse…`, `Use this folder`, `New folder`, `Start there`.
- Tick: `Create a GitHub repo` with the hint `(private)`.
- Older machine: `Update ‹machine name› to use this`.
- Clone progress: `Cloning ‹owner/name›…`.
- The project exists but the chat didn't start: `‹name› was created, but the chat didn't start: ‹reason›`.

## Review Focus

1. **A remote machine on another OS.**
   - Input: a Windows desktop browsing a Linux machine. Expected: `..`, the breadcrumb and Create in previews come out right.
   - Test: Task 7's "never builds a path" test. The dialog shows only paths the service returned, and `folders.list` returns `parent` itself (Task 4).
2. **Hostile or odd names.**
   - Input: `../x`, `a/b`, `C:\x`, `.`, `..`, a name with spaces, a 101-character name. Expected: each is refused before anything is made.
   - Tests: Task 4 (`folders.create`) and Task 6 (`create`).
3. **`gh` or `git` that would prompt or hang** (a locked keyring, an expired token, an HTTPS password prompt).
   - Expected: a plain error within the timeout, never a hang.
   - Test: Task 5 checks the env and timeout handed to every run.
4. **Clone cancel and failure races.**
   - Cancel after the clone finished: the clone is kept.
   - Cancel while it runs: the partial folder is removed.
   - The target appears between the check and the clone: nothing of someone else's is removed.
   - Test: Task 6.
5. **The New chat dialog closed while a clone runs.**
   - Expected: closing cancels the job (this plan's call), and nothing is left half-made.
   - Test: Task 9.

## Out of scope

- The rest of plan 2: worktrees, the "push your work" instruction, Move to…, and switching branches on This PC.
- The "Local only" chip for repos with no remote (base design §10). New project without the GitHub tick makes such repos. The push check already skips them; the chip comes with the later plan-2 items.

## File structure

**Protocol**
- `packages/protocol/src/projects.ts` (new): the schemas below and `PROJECTS_CAPABILITY`.
- `packages/protocol/src/methods.ts`, `version.ts`, `machines.ts`, `index.ts` (modified).

**Service**
- `packages/service/src/projects/folders.ts` (new): `listFolders`, `completeFolder`, `makeFolder`, `expandHome`, `validName`.
- `packages/service/src/projects/github.ts` (new): `Tools` (the gh and git runner), `githubStatus`, `listRepos`, `createRepo`, `startClone`, `originOf`.
- `packages/service/src/projects/maker.ts` (new): `ProjectMaker`, which handles Create in, create, clone jobs, the record and origins.
- `packages/service/src/server/handlers/projects.ts` (new): `registerProjectHandlers`.
- `packages/service/src/server/handlers/chat.ts` (modified): `requireRunnable` is returned for reuse.
- `packages/service/src/main.ts` (modified): wiring and the capability.

**Desktop**
- `apps/desktop/src/lib/projects.ts` (new): typed wrappers over `api.request`, and `supportsProjects(machine)`.
- `apps/desktop/src/lib/components/new-chat/` (new):
  - `FolderBrowser.svelte`
  - `CreateInField.svelte`
  - `ExistingFolderTab.svelte`
  - `NewProjectTab.svelte`
  - `CloneTab.svelte`
- `apps/desktop/src/lib/components/NewChatDialog.svelte` (modified): the tabs, and the submit for each tab.
- `apps/desktop/src/lib/components/chat/MessageList.svelte` (modified): Task 1.
- `apps/desktop/src/lib/notifications.ts` (modified): Task 2.

**Docs**
- `docs/architecture.md` and `docs/remote-machines.md` (modified): Task 10.

---

### Task 1: The message list settles in a long chat (spec §8b)

**Files:**
- Modify: `apps/desktop/src/lib/components/chat/MessageList.svelte:286-301` (the measuring `$effect`)
- Test: `apps/desktop/tests/chat/message-list-settle.test.ts` (new)

**Interfaces:** none (internal to `MessageList`).

- [ ] **Step 1: Write the failing test.** Render `MessageList` with 4,000 `assistantText` items (ids `a0`…`a3999`, markdown of 50 characters, so the estimate is 53 px) and a fresh `ListMemory` with `stick: true`. Two stubs make jsdom lay the list out:
  - `HTMLElement.prototype.getBoundingClientRect` returns `{ height: 120 }` for elements with a `data-row` attribute. Every row is taller than its estimate, so measuring the overscan rows above the viewport shifts everything below them.
  - `HTMLElement.prototype.scrollTop` is a get/set on a per-element backing field (restored in `afterEach`).

  Tests:
  - `a 4,000-row chat opened at the bottom settles without an update-depth error`: rendering and `await tick()` don't throw. Watch `console.error` and the window `error` event too; neither reports `effect_update_depth_exceeded`. The last item's row (`data-row` of `a3999`) is rendered.
  - `measuring rows above the viewport keeps the anchored row in place`: with `stick: false` and an anchor on `a2000`, after settling, the row for `a2000` is rendered and is the first row whose bottom is below `scrollTop`.
- [ ] **Step 2: Run it and watch it fail.** Run: `pnpm --config.verify-deps-before-run=false --filter desktop test -- tests/chat/message-list-settle.test.ts`.
  - Expected: FAIL with `effect_update_depth_exceeded` (or the anchored row drifting).
  - If it passes, the hypothesis in spec §8b is wrong. Stop and use superpowers:systematic-debugging with the stack in the owner's service.log (`ui (navigation)` at 2026-11-02 01:23:31). Ledger what you find before changing code.
- [ ] **Step 3: Fix the measuring effect.**
  - After `measureWindow()` reports a change, bump `version` and also run `reposition()` once the new offsets are in. Read `offsets` inside `untrack` after the bump, or run reposition from the next effect pass. Either way, measuring never leaves `scrollTop` behind on stale offsets.
  - Add the safety net: count consecutive passes in which measuring changed heights. Past **20**, stop measuring in this flush and schedule the rest with the existing `nextFrame`/`applyPending` path. Reset the count whenever a pass changes nothing.
- [ ] **Step 4: Run the test file and all of `tests/chat`.** Expected: PASS, including `virtual.test.ts` and `chat.test.ts`.
- [ ] **Step 5: Commit.** `fix(chat): a very long chat no longer ends in an update loop`.

### Task 2: Coming back after a notification keeps the place (spec §8a)

**Files:**
- Modify: `apps/desktop/src/lib/notifications.ts:99-125` (`openNotified`)
- Test: `apps/desktop/tests/global/notifications.test.ts`

**Wanted behaviour (owner, 2026-11-02):** coming back to the window after a notification changes **nothing**: neither the place nor the open tab. The owner saw both switch when they brought Threadgarden to the front over another window.

- [ ] **Step 1: Change the tests to the wanted behaviour.**
  - The tests at lines 84, 134, 187 and 329 today assert that focus soon after a notification selects Needs you and/or opens the waiting chat. Rewrite them as `focus after a notification keeps the place and the open tab`, covering one waiting chat, several waiting, a finish notification, and a chat on another machine:
    1. Select `{ kind: 'active' }` and open a tab on another chat (`s9`).
    2. The notification arrives while the window is unfocused.
    3. Focus the window.
    4. Assert `places.selected` is still Active, `tabs.active` is still the `s9` tab, and no `sessions.list` with `place.kind === 'needsYou'` was requested for this purpose.
  - Delete the tests that only exist for the heuristic: line 102 (`…about the open chat keeps the place`) is now covered by the above, and line 346 (`a machine failing to list Needs you…`) has no subject left. Line 122 (`focus long after…changes nothing`) stays as it is.
  - Notification posting, the tray badge and `ui.visibility` tests are unchanged.
- [ ] **Step 2: Run and watch the changed tests fail.** Run from `apps/desktop`: `pnpm --config.verify-deps-before-run=false exec vitest run tests/global/notifications.test.ts`. Expected: FAIL, with `needsYou` received where `active` was expected, or the tab moved to `s2`.
- [ ] **Step 3: Remove the focus heuristic.** Delete `openNotified` and everything only it uses: the `notifiedAt`/`notified` bookkeeping, `FOCUS_OPENS_WITHIN_MS`, and its call from the focus handler. Keep whatever the focus handler still needs for `ui.visibility`/`focused`. Drop `places` (and `tabs`, if unused) from the deps. Keep posting notifications exactly as today.
- [ ] **Step 4: Run the file.** Expected: PASS.
- [ ] **Step 5: Commit.** `fix(notifications): coming back to the window no longer switches the place to Needs you`.

### Task 3: Protocol 7, projects schemas and methods

**Files:**
- Create: `packages/protocol/src/projects.ts`
- Modify:
  - `packages/protocol/src/methods.ts` (a `// ── projects (protocol 7)` block at the end);
  - `version.ts` (7, plus a doc line `7 — projects: folders, New project, Clone.`);
  - `machines.ts` (the range and `CAPABILITIES`);
  - `index.ts` (export).
- Test:
  - `packages/protocol/test/schemas.test.ts` (the exhaustive method list);
  - `packages/protocol/test/projects.test.ts` (new).

**Interfaces (Produces), in `projects.ts`:**
```ts
export const PROJECTS_CAPABILITY = 'projects';
export const PROJECT_NAME = /^[A-Za-z0-9._-]{1,100}$/;           // and not '.' or '..'
export const ProjectNameSchema: z.ZodType<string>;              // refine: PROJECT_NAME, not '.'/'..'
export const FolderEntrySchema = z.object({ name: z.string(), path: z.string(), git: z.boolean() });
export const FolderListingSchema = z.object({
  path: z.string(), parent: z.string().nullable(), folders: z.array(FolderEntrySchema),
});
export const GithubStatusSchema = z.object({
  ready: z.boolean(), login: z.string().nullable(), problem: z.string().nullable(),
});
export const RepoSchema = z.object({
  fullName: z.string(), private: z.boolean(), updatedAt: z.number(), defaultBranch: z.string(),
});
export const CloneJobSchema = z.object({
  jobId: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  repo: z.string(), path: z.string(), error: z.string().nullable(),
});
// plus the inferred types: FolderEntry, FolderListing, GithubStatus, Repo, CloneJob
```
**Methods** (all open to paired devices):
```ts
'folders.list':     def(z.object({ path: z.string().min(1).max(4096) }), FolderListingSchema)
'folders.complete': def(z.object({ partial: z.string().min(1).max(4096) }), z.object({ matches: z.array(z.string()).max(50) }))
'folders.create':   def(z.object({ parent: z.string().min(1).max(4096), name: ProjectNameSchema }), z.object({ path: z.string() }))
'projects.createIn': def(empty, z.object({ path: z.string() }))           // remembered, else the default
'projects.create':  def(z.object({ createIn: z.string().min(1).max(4096), name: ProjectNameSchema, github: z.boolean() }),
                        z.object({ path: z.string(), repo: z.string().nullable(), problem: z.string().nullable() }))
'projects.clone':   def(z.object({ createIn: z.string().min(1).max(4096), repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/) }),
                        z.discriminatedUnion('status', [
                          z.object({ status: z.literal('started'), job: CloneJobSchema }),
                          z.object({ status: z.literal('existing'), path: z.string() }),
                        ]))
'projects.job':     def(z.object({ jobId: z.string() }), CloneJobSchema)
'projects.cancel':  def(z.object({ jobId: z.string() }), empty)
'projects.origins': def(empty, z.object({ repos: z.array(z.string()) }))  // lower-case owner/name of this machine's projects' GitHub origins
'github.status':    def(empty, GithubStatusSchema)
'github.repos':     def(empty, z.object({ repos: z.array(RepoSchema) }))
```
**Error codes** (`ServiceError` codes, used by the service and the desktop):
- `INVALID_NAME`
- `NOT_FOUND` ("No such folder")
- `NOT_A_FOLDER`
- `PERMISSION` ("Permission denied")
- `EXISTS`
- `GH_NOT_READY`
- `REPO_EXISTS`
- `GIT_FAILED`
- `GH_FAILED`
- `CLAUDE_MISSING` and `API_KEY_REQUIRED`, reused from chat

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `schemas.test.ts`: add the 11 method names to the exhaustive list.
  - `projects.test.ts`:
    - `ProjectNameSchema` accepts `plant-logger`, `a.b_c-1`, and a 100-character name.
    - It rejects `.`, `..`, `a/b`, `a b`, `C:\\x`, `../x`, empty, and 101 characters.
    - The `projects.clone` result parses both union branches.
    - `REMOTE_PROTOCOL_RANGE` is `{ min: 6, max: 8 }`, and `CAPABILITIES` contains `'projects'`.
- [ ] **Step 2: Run them and watch them fail.** Run: `… --filter @threadgarden/protocol test`. Expected: FAIL (missing exports and methods).
- [ ] **Step 3: Implement** the schemas, methods, version, range and capability.
- [ ] **Step 4: Run.** Expected: PASS. Typecheck all three packages; the service and desktop must still compile.
- [ ] **Step 5: Commit.** `feat(protocol): protocol 7 with folders, projects and GitHub methods`.

### Task 4: Service folders: list, complete, make

**Files:**
- Create: `packages/service/src/projects/folders.ts`
- Test: `packages/service/test/projects/folders.test.ts`

**Interfaces (Produces):**
```ts
export const expandHome = (p: string, home?: string): string;     // '~' and '~/x' → absolute; others unchanged
export const validName = (name: string): boolean;                  // ProjectNameSchema's rule
export const listFolders = (path: string, home?: string): Promise<FolderListing>;
export const completeFolder = (partial: string, home?: string): Promise<string[]>;
export const makeFolder = (parent: string, name: string, home?: string): Promise<string>;
```

**Rules**
- **Relative paths:** a path that is still relative after `expandHome` → `ServiceError('NOT_FOUND', 'Type a full path, or start with ~')`.
- **What is listed:** directories only, sorted by name with `localeCompare`. Names starting with `.` are left out. `git` is true when `<dir>/.git` exists, as a folder or a file.
- **`parent`:** `null` at the filesystem root (`dirname(p) === p`).
- **Errors:**
  - `ENOENT` → `NOT_FOUND` "No such folder";
  - `ENOTDIR` → `NOT_A_FOLDER` "Not a folder";
  - `EACCES`/`EPERM` → `PERMISSION` "Permission denied".
- **`completeFolder`:**
  - A partial ending in a separator lists that folder's children.
  - Otherwise it lists folders in `dirname` whose name starts with `basename`, case-insensitive on win32. Hidden folders are included only when the basename starts with `.`.
  - At most 50, as absolute paths.
- **`makeFolder`:**
  - `!validName` → `INVALID_NAME`; the target exists → `EXISTS`.
  - It runs `mkdir` without `recursive` on the target. The parent must exist.

**Steps**
- [ ] **Step 1: Write the failing tests** on a temp dir. Tree: `code/{alpha(.git dir), beta, .hidden}`, `file.txt`.
  - `lists only visible folders with git marks`: `[{alpha, git:true}, {beta, git:false}]`, and `parent` is the temp dir.
  - `~ means the home folder`: pass `home` = the temp dir, then `listFolders('~/code')`.
  - `a relative path is refused`.
  - `missing, file, and the root`: `NOT_FOUND`; `NOT_A_FOLDER` for `file.txt`; `parent === null` for `parse(tmp).root`.
  - `completes by prefix and lists children after a separator`: `code/al` → `[…/code/alpha]`; `code/` → alpha, beta; `code/.h` → `.hidden`.
  - `makeFolder refuses bad names and existing folders, and makes one level`: `../x`, `a/b`, `..`, `''` → `INVALID_NAME`; `beta` → `EXISTS`; `gamma` → its path exists. A missing parent → `NOT_FOUND`.
- [ ] **Step 2: Run them and watch them fail.** Run: `… --filter @threadgarden/service test -- test/projects/folders.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `folders.ts`.** Use `ServiceError` from `../server/router.js`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(service): list, complete and make folders`.

### Task 5: Service GitHub and git through the machine's own tools

**Files:**
- Create: `packages/service/src/projects/github.ts`
- Test: `packages/service/test/projects/github.test.ts`

**Interfaces (Produces):**
```ts
export type RunResult = { code: number; stdout: string; stderr: string };
export type Tools = {
  /** Runs gh or git to completion (timeout in ms; kills on timeout → code -1, stderr 'timed out'). */
  run(cmd: 'gh' | 'git', args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult>;
  /** Starts a long-running git clone; `cancel` kills it. */
  spawn(cmd: 'git' | 'gh', args: string[], opts: { cwd?: string }): { done: Promise<RunResult>; cancel(): void };
};
export const toolEnv = (base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv; // + GH_PROMPT_DISABLED=1, GIT_TERMINAL_PROMPT=0, LC_ALL=C; GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE removed
export const systemTools: Tools;                                   // execFile/spawn with toolEnv(), windowsHide: true
export const githubStatus = (t: Tools): Promise<GithubStatus>;
export const listRepos = (t: Tools): Promise<Repo[]>;
export const repoExists = (t: Tools, fullNameOrName: string): Promise<boolean>;
export const createRepo = (t: Tools, name: string): Promise<{ fullName: string; url: string }>;
export const startClone = (t: Tools, fullName: string, target: string): { done: Promise<RunResult>; cancel(): void };
export const originOf = (t: Tools, dir: string): Promise<string | null>;   // lower-case owner/name for a github.com origin, else null
```

**Behaviour**
- **`githubStatus`** runs `gh auth status --hostname github.com` (10 s timeout).
  - Missing executable (spawn `ENOENT`) → `{ ready:false, problem:'GitHub CLI (gh) is not installed on this machine.' }`.
  - Non-zero exit → `problem: 'Run gh auth login on this machine (over SSH).'`. If stderr mentions `keyring`, the problem is instead `'gh cannot read its keyring. Run gh auth login --insecure-storage on this machine (over SSH).'`.
  - `login` is parsed from `Logged in to github.com account (\S+)`.
- **`listRepos`** runs `gh api --paginate 'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'` (60 s timeout). The pages are concatenated JSON arrays; parse each array.
  - Fields: `full_name`, `private`, `updated_at` (ms), `default_branch`.
  - Sorted by `updatedAt` descending.
  - A failure → `ServiceError('GH_NOT_READY', <githubStatus problem>)` when the status isn't ready, else `GH_FAILED` with the first stderr line.
- **`createRepo`** runs `gh repo create <name> --private` (30 s), then `gh repo view <name> --json nameWithOwner,url` for the URL. If the name is taken → `REPO_EXISTS` "‹name› already exists on GitHub".
- **`repoExists`** runs `gh repo view <name> --json name` and returns true on exit code 0.
- **`startClone`** runs `git clone --origin origin https://github.com/<fullName>.git <target>`, with `gh auth setup-git` assumed done at setup (docs/remote-machines.md).

**Steps**
- [ ] **Step 1: Write the failing tests** with a fake `Tools` that records calls and replays canned results.
  - `every run gets a no-prompt environment`: `toolEnv({ GIT_DIR: 'x', PATH: 'p' })` has `GH_PROMPT_DISABLED: '1'`, `GIT_TERMINAL_PROMPT: '0'`, `LC_ALL: 'C'`, `PATH: 'p'`, and no `GIT_DIR`.
  - `systemTools` runs with a timeout. Run `node -e "setTimeout(()=>{},5000)"` through a tiny `Tools`-compatible wrapper at `timeoutMs: 200`; it resolves with `code: -1` within 2 s. This is Review Focus 3.
  - `status: ready with login, not signed in, keyring, gh missing`: the four problems, with the exact texts above.
  - `repos: paginated arrays merge, sorted newest first`.
  - `create: private, and a taken name is REPO_EXISTS`: args contain `--private`.
  - `origin: https and ssh github remotes give owner/name; other hosts give null`: `git@github.com:Jiri/A.git` and `https://github.com/jiri/a` → `jiri/a`; `https://gitlab.com/x/y` → null.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `github.ts`.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(service): GitHub status, repos, create and clone through gh`.

### Task 6: Service ProjectMaker: create, clone jobs, Create in, record

**Files:**
- Create: `packages/service/src/projects/maker.ts`
- Test: `packages/service/test/projects/maker.test.ts`

**Interfaces:**
- **Consumes:** Task 4's `expandHome`, `validName`, `listFolders`. Task 5's `Tools`, `githubStatus`, `repoExists`, `createRepo`, `startClone`, `originOf`.
- **Produces:**
```ts
export type MadeEntry = { path: string; repo: string | null; kind: 'new' | 'clone'; createdAt: number };
export type ProjectMakerDeps = {
  tools: Tools;
  store: { get(key: string): unknown; set(key: string, v: unknown): void };  // the db's ui state
  headless: boolean;
  home: string;
  recentCwds: () => string[];             // most recent first
  requireRunnable: () => Promise<void>;
  now?: () => number;
  newId?: () => string;
};
export const CREATE_IN_KEY = 'projects.createIn';
export const MADE_KEY = 'projects.made';
export class ProjectMaker {
  constructor(deps: ProjectMakerDeps);
  createIn(): string;                                                  // remembered, else the default (Global Constraints)
  create(p: { createIn: string; name: string; github: boolean }): Promise<{ path: string; repo: string | null; problem: string | null }>;
  clone(p: { createIn: string; repo: string }): Promise<{ status: 'started'; job: CloneJob } | { status: 'existing'; path: string }>;
  job(jobId: string): CloneJob;                                        // unknown → ServiceError('NOT_FOUND', 'No such clone')
  cancel(jobId: string): void;
  origins(): Promise<string[]>;                                        // originOf for each recentCwds() entry, de-duplicated
  made(): MadeEntry[];
}
```

**`create`, in order (spec §4):**
1. **Checks:** `validName` (else `INVALID_NAME`), then `requireRunnable()`.
   - The `createIn` directory exists, or it is the default headless Create in (`~/threadgarden/projects`), which is made with `recursive`. Anything else missing → `NOT_FOUND`.
   - The target `<createIn>/<name>` doesn't exist (else `EXISTS`, message `‹name› already exists in ‹createIn›. Use the Existing folder tab to start there.`).
   - With `github`: `githubStatus` is ready (else `GH_NOT_READY`) and `!repoExists(name)` (else `REPO_EXISTS`).
2. **Make:** `mkdir` the target, then `git init` (`GIT_FAILED` on failure). On any failure up to here, `rm -r` the target **only if this call created it**, then rethrow.
3. **With `github`:**
   - `createRepo`. If that fails, remove the target as in step 2 and rethrow.
   - Once the repo exists, `git remote add origin <url>`. If that fails, don't remove anything: return `problem: 'the GitHub repo was created, but connecting it failed: ‹first stderr line›'`.
4. **Finish:** append `{ path, repo, kind: 'new', createdAt }` to `MADE_KEY`, and set `CREATE_IN_KEY` to the resolved `createIn`. Return.

**`clone`:**
- **Target:** `<createIn>/<repo name part>`.
- **If the target exists:** when `originOf(target)` equals the lower-cased `repo`, return `{ status: 'existing', path }`. Otherwise throw `EXISTS`.
- **Checks:** `requireRunnable()`, then `githubStatus` ready (else `GH_NOT_READY`).
- **Start:** create a job (`state: 'running'`) and `startClone`. On completion:
  - **Code 0:** `done`; record `{ kind: 'clone' }` and set `CREATE_IN_KEY`.
  - **Non-zero:** `failed`, with `error` = the first stderr line that starts with `fatal:` (else `git clone failed`). Remove the target if it exists and wasn't there before the job started.
  - **Cancelled:** `cancel` sets `cancelled`, kills the process, and removes the target under the same rule. `cancel` on a job that is no longer running does nothing.
- **Lifetime:** a finished job stays readable for 10 minutes, then it is forgotten.

**Steps**
- [ ] **Step 1: Write the failing tests.** Use a temp home, an in-memory store, a fake `Tools` (from Task 5's test helpers; move it to `test/projects/fake-tools.ts`), and `requireRunnable` as a spy.
  - `createIn defaults: headless ~/threadgarden/projects, desktop the parent of the most recent project, else home; remembers the last used`.
  - `create makes the folder and git init and records it`: the fake git creates `.git`; `made()` has one `new` entry, and `createIn()` returns the new place.
  - `create refuses before making anything`. For each of these, the fake tools record no calls after the check and no folder exists:
    - a bad name (`../x`);
    - an existing target, with the exact message;
    - Claude missing (`requireRunnable` rejects with `CLAUDE_MISSING`);
    - gh not ready;
    - repo taken.
  - `a failed git init removes only the folder it made`.
  - `a failed repo creation removes the new folder; a failed remote add keeps everything and returns a problem`.
  - `a missing Create in is NOT_FOUND unless it is the headless default, which is made`.
  - `clone: existing same repo → existing; existing other folder → EXISTS; gh not ready → GH_NOT_READY`.
  - `clone job: done records it; failed removes the partial folder with the fatal line as error; cancel while running removes it; cancel after done keeps it`. This is Review Focus 4.
  - `clone never removes a target that existed before the job`: the fake spawn creates the target before failing, and the test pre-creates it after the existence check by hooking the fake. The folder stays.
  - `origins de-duplicates and skips non-GitHub projects`.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL (module missing).
- [ ] **Step 3: Implement `maker.ts`.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(service): ProjectMaker creates and clones projects and records them`.

### Task 7: Service handlers and wiring

**Files:**
- Create: `packages/service/src/server/handlers/projects.ts`
- Modify:
  - `packages/service/src/server/handlers/chat.ts:577`: return `{ send, requireRunnable }`;
  - `packages/service/src/main.ts`: register next to `registerFileHandlers` (around line 796). Use `opened.getUiState/setUiState` as the store, `os.homedir()`, `headless`, `() => opened.recentCwds().map((r) => r.cwd)`, and `chatHandlers.requireRunnable`. Line 238's capabilities already spread `CAPABILITIES`, so `projects` comes with Task 3.
- Test: `packages/service/test/server/projects.test.ts` (new), `packages/service/test/server/local-only.test.ts`.

**Interfaces (Produces):**
```ts
export const registerProjectHandlers = (router: Router, deps: { maker: ProjectMaker; tools: Tools; home: string }): void;
```
It maps the 11 methods to Tasks 4 to 6. None is `localOnly`. `startService` options gain `projectTools?: Tools`, so tests can inject a fake.

**Steps**
- [ ] **Step 1: Write the failing tests**, through `startService` as `ui-error.test.ts` does, with `projectTools` set to a fake.
  - `hello reports the projects capability`.
  - `folders.list over the protocol returns the listing with parent from the service` (Review Focus 1).
  - `projects.create then chat.create starts a chat in the new folder`.
  - `projects.clone → projects.job polls to done`.
  - `projects.create with Claude missing is CLAUDE_MISSING and makes nothing`.
  - `local-only.test.ts`: the 11 methods are **not** forbidden to a paired device. Add them to the allowed side, or assert that they don't return `FORBIDDEN`.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL (`METHOD_NOT_FOUND`).
- [ ] **Step 3: Implement and wire.**
- [ ] **Step 4: Run the full service suite.** Run: `… --filter @threadgarden/service test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(service): projects, folders and GitHub methods for every machine`.

### Task 8: Desktop folder browser and Create in field

**Files:**
- Create:
  - `apps/desktop/src/lib/projects.ts`
  - `apps/desktop/src/lib/components/new-chat/FolderBrowser.svelte`
  - `apps/desktop/src/lib/components/new-chat/CreateInField.svelte`
- Test: `apps/desktop/tests/new-chat/folder-browser.test.ts` (new)

**Interfaces (Produces):**
```ts
// projects.ts
export const supportsProjects = (m: MachineEntry | undefined): boolean;  // info.capabilities includes PROJECTS_CAPABILITY
export const projectsApi = (api: Api) => ({
  list: (path: string) => Promise<FolderListing>,
  complete: (partial: string) => Promise<string[]>,
  makeFolder: (parent: string, name: string) => Promise<string>,
  createIn: () => Promise<string>,
  create: (p: Params<'projects.create'>) => Promise<Result<'projects.create'>>,
  clone: (p: Params<'projects.clone'>) => Promise<Result<'projects.clone'>>,
  job: (jobId: string) => Promise<CloneJob>,
  cancel: (jobId: string) => Promise<void>,
  origins: () => Promise<string[]>,
  githubStatus: () => Promise<GithubStatus>,
  repos: () => Promise<Repo[]>,
});
```

**Components**

`FolderBrowser.svelte`, props `{ api: ReturnType<typeof projectsApi>; machineName: string; start: string; onPick: (path: string) => void; onCancel: () => void }`:
- It is a dialog titled `Choose a folder on ‹machineName›`.
- **Path box** (labelled `Path`): Enter loads the path; Tab completes it with `complete`. One match replaces the box text with it. Several matches fill the box with their longest common prefix.
- **Breadcrumb:** built from the service's `path` and repeated `parent` values. Clicking a crumb loads it.
- **List:** `..` (when `parent` isn't null), then the folders. A git folder carries a `git` mark. Clicking a folder loads it.
- **New folder:** an inline name input, then `makeFolder`, then it loads the new folder.
- **Buttons:** `Use this folder` calls `onPick(current path)`; `Cancel` calls `onCancel`.
- **Errors** appear in a `role="alert"` line, and the last good listing stays.

`CreateInField.svelte`, props `{ value: string; onChange(v: string): void; browse: () => void }`:
- a text input labelled `Create in`, plus a `Browse…` button.

**Steps**
- [ ] **Step 1: Write the failing tests** with a fake `projectsApi`.
  - `opens on start and lists folders with git marks`.
  - `typing a path and Enter loads it; Tab completes a single match`.
  - `.. and breadcrumb use the service's parent, never a client-built path`: give a Windows-style listing (`C:\\Users\\j`, parent `C:\\Users`). Clicking `..` calls `list('C:\\Users')` exactly (Review Focus 1).
  - `New folder makes it and opens it`.
  - `an error shows in place and keeps the last listing`.
  - `Use this folder returns the current path`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): a folder browser for other machines`.

### Task 9: New chat tabs: Existing folder and New project

**Files:**
- Create:
  - `apps/desktop/src/lib/components/new-chat/ExistingFolderTab.svelte`
  - `apps/desktop/src/lib/components/new-chat/NewProjectTab.svelte`
- Modify: `apps/desktop/src/lib/components/NewChatDialog.svelte`
- Test:
  - `apps/desktop/tests/new-chat/new-project.test.ts` (new);
  - update `apps/desktop/tests/chat/remote-chat.test.ts:183-210`, where the disabled "Choose folder…" assertion becomes the Browse… behaviour.

**Interfaces:**
- **Consumes:** Task 8.
- **Produces:** the dialog keeps its tab in `let tab = $state<'existing' | 'new' | 'clone'>('existing')`, which Task 10 fills. The composer's submit dispatches by tab.

**Behaviour**
- **Layout:** the tabs come under the Machine select, as a `role="tablist"` with tabs named exactly `Existing folder`, `New project`, `Clone`. Model, Permission mode and the composer stay below the tabs, shared by all three.
- **Existing folder:** today's select. `Choose folder…` becomes `Browse…`:
  - On This PC it opens `pickFolder()`, as today.
  - On another machine it opens `FolderBrowser` (started at the selected folder, else the machine's home), and the picked path joins the list like `picked` does today.
- **New project:**
  - The `Name` input. An invalid name shows `Letters, digits, . _ - only (at most 100)` under the field and disables sending.
  - `CreateInField`, initialised from `createIn()` each time the tab or machine changes. Its Browse… uses the native picker on This PC and `FolderBrowser` elsewhere.
  - `Create a GitHub repo` `(private)`, unticked. It is disabled, with the `githubStatus().problem` as its title, when not ready.
  - **The preview line:** `→ ‹createIn›/‹name›`. Display only; it is never sent anywhere. Use the separator of the machine's `info.platform` (`win32` → `\`).
  - **Composer:** while on this tab, its `cwd` is the Create in value and its `draftKey` is `new:project:‹machineId›`.
- **Submit on New project:**
  1. `projects.create`, then `chats.create({ cwd: result.path, … })` exactly as today.
  2. An error from `projects.create` shows in the dialog's alert; fields and text stay.
  3. If `result.problem` is set, or `chats.create` throws after `projects.create` succeeded, show `‹name› was created, but the chat didn't start: ‹reason›`, with a `Start there` button. It switches to Existing folder with `result.path` added and selected, keeping the message.
- **Older machine:** when `!supportsProjects(machine)`, the New project and Clone tabs and Browse… are disabled, with the title `Update ‹machine name› to use this`. This PC always supports them.

**Steps**
- [ ] **Step 1: Write the failing tests**, using `setupTwoMachines` as `remote-chat.test.ts` does, with fake handlers for the new methods.
  - `three tabs with the exact names; Existing folder by default`.
  - `Browse… on another machine opens the folder browser and starts the chat in the picked folder`.
  - `New project creates the project on the chosen machine, then starts the chat in it`: `remote.calls('projects.create')[0].params` equals `{ createIn: '/home/jiri/threadgarden/projects', name: 'plant-logger', github: true }`, then `chat.create` gets `cwd: '/home/jiri/threadgarden/projects/plant-logger'`.
  - `an invalid name blocks sending and says why`.
  - `GitHub tick disabled with the reason when gh is not ready`.
  - `a project made but the chat failed offers Start there, which keeps the message`.
  - `an older machine (no projects capability) disables New project, Clone and Browse… with the update hint`.
  - `This PC's New project uses This PC's service`: `server.calls('projects.create')` gets one call, and `remote` gets none.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file, `tests/chat/remote-chat.test.ts`, `tests/global/api-key-only.test.ts` and `tests/interaction/setup.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): New chat tabs with Browse and New project`.

### Task 10: Clone tab, and the docs

**Files:**
- Create: `apps/desktop/src/lib/components/new-chat/CloneTab.svelte`
- Modify:
  - `apps/desktop/src/lib/components/NewChatDialog.svelte`;
  - `docs/architecture.md`, the git access note: Threadgarden now also makes new folders, and runs `git init`/`git clone` in them, on any machine;
  - `docs/remote-machines.md`, a short "Starting projects" section: New project, Clone, Browse, and that Clone and the GitHub tick need `gh auth login` (with `--insecure-storage` on a headless machine) and `gh auth setup-git`.
- Test: `apps/desktop/tests/new-chat/clone.test.ts` (new)

**Behaviour (spec §5)**
- **The list:**
  - On opening the tab, call `githubStatus()`. When not ready, show its `problem` instead of a list.
  - When ready, call `repos()` and `origins()` on **This PC's** scope.
  - Rows show `owner/name`, `private`/`public`, and the relative update time with the existing relative-time formatter. A repo is marked `on This PC` when its lower-cased full name is in the origins.
  - A search box filters case-insensitively on `fullName`.
- **Create in:** the same `CreateInField` and remembered value as New project.
- **Submit:** call `projects.clone`.
  - `existing`: show `Already cloned in ‹path›` with `Start there`, which starts the chat there with the message.
  - `started`: show `Cloning ‹owner/name›…` with `Cancel`, and poll `projects.job` every 1 s.
  - `done`: `chats.create` in `job.path`.
  - `failed`: show `job.error`, and keep the selection and the message.
  - **Closing the dialog while running calls `projects.cancel`** (Review Focus 5).
  - If `chats.create` fails after a successful clone, use the same `‹name› was created, but the chat didn't start: …` + `Start there` as Task 9.

**Steps**
- [ ] **Step 1: Write the failing tests.**
  - `lists the machine's repos newest first, marks those on This PC, filters by search`.
  - `gh not ready shows the problem text instead of a list`.
  - `cloning polls to done and starts the chat in the clone`.
  - `an existing clone offers Start there`.
  - `a failed clone shows git's reason and keeps the message`.
  - `closing the dialog while cloning cancels the job`: one `projects.cancel` call with the job id.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, and write both docs changes.
- [ ] **Step 4: Run the whole desktop suite**, then typecheck and lint for all packages. Run: `… --filter desktop test`, `pnpm --config.verify-deps-before-run=false typecheck`, `pnpm --config.verify-deps-before-run=false lint`. Expected: all PASS.
- [ ] **Step 5: Commit.** `feat(desktop): Clone any repo the machine's GitHub account reaches`.

## After the build

**Manual acceptance with the owner**, after the release and a manual Ubuntu update to protocol 7:
1. On kumbal-machine, Browse… to a folder outside the projects folder, and start a chat there.
2. New project `tg-smoke` with the GitHub tick: a private repo appears on GitHub. The chat starts, and Claude's first push lands there.
3. Clone a private repo from the account. Cancel one clone halfway; nothing is left behind.
4. On This PC, with Active selected, a notification arrives from another tab's chat. Coming back and clicking that tab keeps Active.
5. A long chat (this one) takes several messages, including one sent mid-turn, without the error screen.
