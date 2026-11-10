# Bypass permissions: WSL root verification

PR #29 review follow-up, tested on 2026-11-09 in Ubuntu on WSL 2.
Used native Linux Claude Code 2.1.319 and Node 22.23.4, running as UID 0.
Each probe used an isolated temporary home/config directory, a fake API key,
and a localhost Anthropic-compatible streaming provider. No Claude credits or
existing user configuration were used.

## CLI behavior

| Invocation | Result |
| --- | --- |
| Normal print-mode turn without bypass flags | Exit 0; successful `OK` result |
| Same turn with only `--allow-dangerously-skip-permissions` | Exit 1 before contacting the provider |
| Same turn with that flag and `--permission-mode bypassPermissions` | Exit 1 before contacting the provider |

Both failures reported:
`--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`.
The opt-in flag alone therefore breaks ordinary root sessions too.

## Fixed adapter behavior

Bundled the branch's actual `RealAdapter` and its installed Agent SDK for native
Linux Node, supplying the native Claude binary and the same local provider.
Completed a new session in `plan` mode, closed it, then resumed its session ID
in `acceptEdits` mode. Both turns returned successful `OK` results; the selected
modes were retained and `allowDangerouslySkipPermissions` was absent in both
sets of query options.

Repeated the same new/resumed SDK probe as UID 1000. Both turns succeeded with
their selected modes retained and `allowDangerouslySkipPermissions: true`.

The fix omits the opt-in when `process.getuid()` is zero. Other users and
platforms without that API retain it for live permission-mode changes.
An explicitly selected bypass mode is still forwarded unchanged; the CLI
continues to reject bypass as root rather than silently using another mode.

Automated coverage also checks root/new/resumed options, non-root options,
platforms without `getuid`, confirmation/cancellation in both pickers, and
preservation of the confirmed mode through queued delivery.
