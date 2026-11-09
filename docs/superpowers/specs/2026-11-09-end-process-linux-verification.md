# End external process: Linux verification

PR #30 review follow-up, tested on 2026-11-09 in Ubuntu on WSL 2,
with native Linux Claude Code 2.1.319 and Node 22.23.4, as a regular user.

Used a temporary workspace and isolated home/config, a fake API key, and a
localhost Anthropic-compatible streaming provider. No Claude credits or real
user configuration were used. The provider requested a Bash tool invocation
that started an actual Python HTTP dev server on a loopback ephemeral port.
The server recorded its own pid so its lifetime could be checked separately.

Two cases were exercised: a foreground Bash invocation during an active turn,
and a Bash invocation with `run_in_background: true` while Claude's streaming
input remained open. In each case the dev-server process was verified running,
then the branch's actual `endProcessTree` was bundled and invoked with the
Claude parent pid using native Linux Node.

Both Claude parents exited with code 143 after SIGTERM. Both dev-server child
processes stopped too; `/proc` checks excluded zombies from running processes.
No forced termination was needed in either successful probe.

This verifies Linux cleanup for this Claude version and these Bash children.
It does not establish that every external tool handles shutdown correctly.
macOS was not available for a manual Claude-child-process probe; its SIGTERM
path still needs that platform check. Automated process tests run in CI on
Windows, Linux and macOS.

The five-second registry wait remains bounded. A timeout now reports
`STOP_PENDING`: the stop signal was sent, but exit has not yet been confirmed,
and the process may need more time. It does not claim the signal failed or
allow a second session to bypass the normal fresh resume-safety check.
