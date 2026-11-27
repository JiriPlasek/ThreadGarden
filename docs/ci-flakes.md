# Known CI flakes

Checks that have failed without a code bug, and what to do about each. The
`/ci-triage` skill reads this file. Add a section when a new flake is
confirmed; mark one fixed with the commit that fixed it.

Before calling any e2e timeout a flake, download the failure artifact
(`gh run download <id> -n playwright-<target>`) and read `error-context.md`,
the page snapshot taken at the failure. One timeout that looked like a flake
turned out to be a real crash ("Something went wrong"), visible only there.

CI runs once per commit (a branch through its pull request, `main` on push),
so a "twin" run exists only when a commit was seen by both. Playwright retries
a failed test once on CI; a test that passes on retry is reported as flaky,
not failed.

## Windows e2e: `openApp` stuck at 250 chats

- **Test and job:** first e2e spec (`activity.spec.ts`), `openApp`, in
  `bundle (windows-latest)`.
- **Symptom:** the Active count stays at a low number (250, 62) instead of
  1001 for the whole 60 s wait.
- **Cause:** the mock is still indexing on a slow runner; a timing race, not a
  regression.
- **Status:** open. The e2e retry added in 9a45bcc may absorb it.
- **Do:** `gh run rerun <id> --failed`; merge when green.

## Windows e2e: pairing a second machine

- **Test and job:** `machines.spec.ts` "pair with a second machine...", times
  out at `Permission request: Bash`, in `bundle (windows-latest)` only.
- **Status:** fixed (e5fbab4). It was a real crash, not a flake: the page
  snapshot showed "Something went wrong - each_key_duplicate". The message list
  keyed a queued row by its message id, and the user item arrives in a separate
  update, so slow runners rendered both at once.
- **Do:** if it fails again, it is a new cause. Download the artifact and
  investigate.

## `mock-main.test.ts` remote service

- **Test:** "mock service --remote ... keeps its fixed code live"
  (`expected [] to deeply equal [['tg-cli', ...]]`).
- **Status:** fixed (d8f2b0f, PR #7). The indexer listed projects only after
  its last batch.
- **Do:** if it fails again, it is a new cause; investigate rather than re-run.

## Windows: `release.test.ts` sumsFor timeout

- **Test and job:** `release.test.ts > sumsFor > lists every file but
  SHA256SUMS...`, 5007 ms against a 5000 ms limit, in `check (windows-latest)`.
- **Seen on:** a release run, where it blocked the draft and publish jobs.
- **Status:** open. Service tests have a longer timeout on CI since 9a45bcc;
  not seen since.
- **Do:** `gh run rerun <id> --failed` also re-runs the skipped dependent jobs.

## macOS: `file-index.perf.test.ts` event-loop stall

- **Test and job:** "building a 200,000-entry listing never stalls the event
  loop", 501 ms against a 150 ms budget, in `check (macos-latest)`.
- **Status:** open; the twin run passed.
- **Do:** rerun the failed job. If it repeats across commits, a budget or the
  code needs a look.

## Windows: `move/transfer.test.ts` 9 MiB chat

- **Test and job:** "a 9 MiB chat moves in 3 parts", `check (windows-latest)`.
  Also seen locally under load.
- **Status:** open; the twin run passed.
- **Do:** rerun the failed job.

## Local only: machine under load

- Full service and desktop suites fail with timeouts and garbled typing, a
  different set each run, when the PC is busy (games running, or
  `pnpm -r test` running desktop and service in parallel). The same files pass
  alone, and CI passes. Headless start-up tests in service (`main.test.ts`,
  `power/idle.test.ts`, `power/shutdown.test.ts`) hit the 5 s timeout this way.
- **Do:** run the failing file alone before suspecting the code.

## Not a flake: macOS job "fails" at exactly 15 minutes

- **Symptom:** `check (macos-latest)` or `rust (macos-latest)` "fails" at
  exactly 15 min with no steps.
- **Cause:** the job is `cancelled` and `runner_name` is empty: no macOS runner
  was ever assigned. It can repeat on re-run.
- **Do:** check `gh run view <id> --json jobs`. A job with no steps and no
  runner is neither a pass nor a code failure. If another run of the same
  commit passed the same jobs, that is enough evidence to merge; otherwise wait
  and rerun.
