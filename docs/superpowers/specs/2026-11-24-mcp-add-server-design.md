# Add and remove MCP servers from the chat

Approved by the owner on 2026-11-24. A small change on top of "MCP servers in the chat"
(`2026-11-22-mcp-servers-design.md`); ships in 0.12.0 with it and with `!` commands.

## Why

During the hardware test of the MCP servers dialog the owner asked for a way to add servers there instead of SSH-ing
into a machine to run `claude mcp add`. Browsing a catalog (the public MCP Registry) was considered and set aside by
the owner for now: anyone can publish there, so it needs a trust story first. It stays in the vault's *To decide*.

## Goals

- **Add server** in the MCP servers dialog: name, type (URL over http, or a command over stdio with arguments),
  optional headers (http) or environment variables (stdio), and who uses it.
- **Remove** a server from its **⋯** menu, after a confirmation.
- Both act on the chat's machine (This PC, kumbal, a Windows worker), from the desktop and the phone.

## Non-goals

- Browsing or searching a catalog (deferred by the owner).
- Editing a server in place (remove and add again).
- claude.ai connectors and plugin servers: they're managed on claude.ai and by plugins; their rows get no Remove.
- MCP for Codex chats.

## Anti-goals

- Threadgarden never writes Claude Code's config files itself; Claude Code's own CLI does the writing.
- Header and environment values (often API keys) are never logged, never put in events, errors or the database.
  The form shows them masked.

## Approaches

- **Run Claude Code's CLI on the chat's machine (chosen):** the service spawns the same `claude` it already uses,
  with `mcp add-json <name> <json> --scope <scope>` and `mcp remove <name> --scope <scope>`, in the chat's folder.
  Claude Code owns the config format and the scopes.
- Write Claude Code's config files ourselves: breaks the rule that Threadgarden never writes the config dir, and the
  format is Claude Code's to change. Rejected.
- The SDK's per-session servers (`setMcpServers`): gone when the chat restarts. Rejected.

## Decided

```
MCP servers (this chat)                       [+ Add server]
  etoro   project   Connected            ⋯  (… · Remove)

Add MCP server
  Name      [ sentry              ]
  Type      (•) URL (http)   ( ) Command (stdio)
  URL       [ https://mcp.sentry.dev/mcp ]
  Headers / Environment   [+ add]   (values hidden)
  Who uses it  (•) Me, this project   ( ) Me, every project   ( ) Everyone (.mcp.json)
                                             [Cancel] [Add]
```

- **Who uses it** maps to Claude Code's scopes: *Me, this project* = `local` (the default, as in the CLI);
  *Me, every project* = `user`; *Everyone (.mcp.json)* = `project`, with a note that this file is usually committed
  and shared with everyone who clones the project.
- **Add** runs on the chat's machine; Claude Code's error text is shown as it words it (a name already taken, a bad
  URL). Then the new server appears in the list and signs in like any other (Sign in / paste the address).
- **Remove** is in the **⋯** menu of servers whose source is `local`, `user` or `project`, with a confirmation
  naming the server and the scope; it removes from that scope only.
- A Claude chat only, on a machine that offers the feature (a capability, like `mcp`; same protocol version as the
  release's other changes).

## Left to the builder

- **Check first:** does a live chat see a server added with `claude mcp add-json` after a reconnect (or
  `mcpServerStatus` alone), or only after its process restarts? If only after a restart, restart the chat's process
  between turns (the same way an idle chat is reclaimed and resumed) and say so in the dialog
  (`Added. It appears when this chat restarts between turns.`). Same question for Remove.
- How the service finds the `claude` binary on each machine (reuse what the SDK adapter already resolves) and on a
  Windows native worker.
- The form's validation (name characters Claude Code accepts, URL shape), and keeping keys out of process arguments
  if a machine's process list is visible to other users (pass the JSON on stdin with `add-json -` where the CLI
  supports it).
- The protocol method names, the capability name and the mock's fake add/remove for the UI and e2e.
