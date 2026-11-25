# Spike results: adding and removing MCP servers through the CLI (2026-11-24)

**Headline: REMOVE is seen only after a restart (`REMOVE_SEEN_BY = 'restart'`), so Task 4 (the restart branch) is built.** ADD needs one `reconnectMcpServer(name)`. Reading the JSON from stdin works.

## Setup

- `claude` 2.1.330 (the one `findInstalledClaude` picks), Windows 11, the owner's real login. Test: `packages/service/test/real/mcp-config.real.test.ts` (opt-in, `THREADGARDEN_REAL=1`), run with `pnpm --filter @threadgarden/service test:real mcp-config.real`.
- The CLI runs as the service will: `execFile`, no shell, the temp folder as `cwd`, `env` = `buildSessionEnv(process.env without CLAUDECODE and CLAUDE_CODE_* variables)`. Servers are `tg-spike-<8 hex>-*`: the echo fixture over stdio, plus one `http` server (`https://mcp.linear.app/mcp`) with the fake header `X-Tg-Spike: SPIKE-SECRET-VALUE`.
- Live sessions come from `RealAdapter.start` with no prompt; status comes from the Query's `mcpServerStatus()`. The user-scope server was removed in `afterAll`; `afterAll` removes it, then checks with `claude mcp list` (never `mcp get`, which prints header values) that none remains, and fails the run otherwise. It was clean after the run.
- `~/.claude.json` keeps `projects` entries for temp folders: 4 of the 6 folders of a run (read only, not edited by us). The 4 are the folders where a `local`-scope server was written (C1, C2 local, C5, C6); the `user` and `project` folders left none.
- The test pins the constants below with `expect`s, so a CLI update that changes one fails the run.
- **Inside a Claude Code session, `add-json ... -` is refused** (`Reading the JSON from stdin is refused inside a Claude Code session, because its permission prompt would not show the server. Run the command outside the session.`, exit 1). The trigger is the variable `CLAUDE_CODE_CHILD_SESSION` (bisected: `CLAUDECODE` and the other `CLAUDE_CODE_*` variables alone do not trigger it), and the test verifies the refusal by setting it. The test strips `CLAUDECODE` and `CLAUDE_CODE_*` from the CLI's environment, like a service started by the app. A service started from a terminal inside a Claude Code session would hit this refusal.

## Results

| Check | Result |
| --- | --- |
| C1 stdin | `add-json <name> - --scope local` with the JSON on stdin: exit 0, stdout `Added stdio MCP server <name> to local config`. `mcp get` shows it Connected. Works. |
| C2 live add, local | After the add, polling status for 10 s: absent. After `reconnectMcpServer(name)` (returns `{}`): present, `connected`, tools `["echo"]`. New process in the folder: present. |
| C2 live add, project | Writes `<tmp>/.mcp.json` (keys: the server name only). Same as local: absent while polling, present after reconnect and in a new process. Connected after the reconnect with no approval step (observed here, in a fresh temp folder; on this machine, with its own settings). |
| C3 user scope | Same as local: absent while polling, present after reconnect and in a new process. Remove: see C4. User-scope server removed in cleanup, verified gone. |
| C4 live remove (local, project, user) | After the remove: the live session still lists the server as `connected` (polling 10 s). `reconnectMcpServer(name)` errors `Server not found: <name>`, and the entry stays `connected`. A new process in the folder: absent. Only a restart shows a removal. |
| C5 values | See below. |
| C6 refusals | See "Constants". |

## Findings

- **Add is live with one reconnect; remove is not live.** A server added after the session started is unknown to the session, so status does not list it until `reconnectMcpServer(name)`, which then connects it. A removed server stays in the session's list as `connected` (a ghost that no longer reconnects) until the process restarts.
- Scope shows up as `source` and `scope` on the status entry, both equal to the CLI's `--scope` value.
- The CLI accepts a bad URL (`not a url`, `ftp://example.com`) and writes the server (exit 0). Only the shape is validated (`command: expected string, received undefined`). The form must validate URLs itself.
- The same name in another scope is accepted (a `local` and a `project` copy of one name coexisted). The refusal is per scope only.
- A name with a leading `-` is read as an option unless the arguments are `add-json --scope local -- -x -` (`remove --scope local -- -x` works the same). Then it is accepted.
- `claude mcp get <name>` prints header values in full (`X-Tg-Spike: SPIKE-SECRET-VALUE`). The service must never run `get` or surface its output.
- Success is on stdout, exit 0. A refusal is on stderr, exit 1, stdout empty. No ANSI colour in the output (the CLI had no TTY). `remove` success also prints `File modified: <path>` (a file path; the project folder for local scope).

## Constants for the build

```
STDIN_WORKS = true   // outside a Claude Code session: strip CLAUDECODE / CLAUDE_CODE_* from the CLI env (CLAUDE_CODE_CHILD_SESSION is the trigger)
ADD_SEEN_BY = 'reconnect'      // reconnectMcpServer(name) after the add; status polling alone never sees it
REMOVE_SEEN_BY = 'restart'     // status keeps the ghost as 'connected'; reconnect errors "Server not found: <name>"
```

`SOURCE_OF_SCOPE` (status entry of a server added at each scope):

| `--scope` | `source` | `scope` | `config.type` (stdio server) | `config.type` (http server) |
| --- | --- | --- | --- | --- |
| `local` | `local` | `local` | `stdio` | `http` |
| `user` | `user` | `user` | `stdio` | not observed (inferred `http`) |
| `project` | `project` | `project` | `stdio` | not observed (inferred `http`) |

`VALUES_IN_STATUS`: **yes for headers**: the `http` server's `mcpServerStatus()` entry contains the header value (the whole entry was searched). **No for env**: the stdio entry does not contain the `env` value. `claude mcp list` contained neither. `claude mcp get` prints header values (and env, if set). So the service must redact the header value from any status entry it forwards, and never call `get`.

`EXIT`: success exits 0, message on stdout. Refusal exits 1, message on stderr, stdout empty. No ANSI colour in either (no TTY). `-x` as a name: `error: unknown option '-x'` (exit 1, stderr).

`DUPLICATE_ERROR` (same name, same scope, exit 1, stderr):
`MCP server <name> already exists in local config`; at project scope `MCP server <name> already exists in .mcp.json` (both verified). Same name in another scope: not an error, `Added stdio MCP server <name> to project config` (exit 0).

`BAD_URL_ERROR`: none. `{"type":"http","url":"not a url"}` and `ftp://example.com` are both accepted: `Added http MCP server <name> to local config` (exit 0).

`NOT_FOUND_ERROR` (remove from a scope lacking the name, exit 1, stderr):
- user: `No MCP server named "<name>" in user scope`
- project: `No MCP server named "<name>" in .mcp.json`
- local: `No MCP server named "<name>" in local scope` (verified by removing twice)

`BAD_JSON_ERROR` (exit 1, stderr, the input is **not** echoed):
- not valid JSON, or not an object: `Invalid configuration: not a JSON object. Check its quotes, commas and braces.`
- wrong shape: `Invalid configuration: command: expected string, received undefined`

`NAME_RULE` (only letters, numbers, hyphens and underscores):

| Name | Result |
| --- | --- |
| `a b` | refused |
| `a.b` | refused |
| `-x` | read as an option unless after `--` (`error: unknown option '-x'`); then accepted |
| `ä` | refused |
| `a_b-1` | accepted |

Refusal text (exit 1, stderr): `Invalid name <name>. Names can only contain letters, numbers, hyphens, and underscores.`
