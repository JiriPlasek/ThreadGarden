---
name: ci-triage
description: Use when a CI run on a branch or pull request has failed and you must decide whether it is a known flake (rerun) or a real failure (debug). Also when a check seems stuck, cancelled or timed out.
---

# CI triage

Decide per failure: known flake, cancelled runner, or real. Rerunning needs no
approval; anything that changes the repo does.

## Checklist

1. **Find the failures.** `gh run list --branch <branch> --status failure`.
   Also look at the other run of the same commit (the "twin"): it may have
   passed the same jobs. Note the run ids.
2. **Read the failing jobs.** `gh run view <id> --log-failed`. Name the exact
   job, the test and the first error line.
3. **Cancelled, not failed?** `gh run view <id> --json jobs`. A macOS job
   "failing" at exactly 15 min with no steps and an empty `runner_name` is a
   cancelled job (no runner assigned), not a flake and not a bug.
4. **e2e failure?** Download the artifact before judging:
   `gh run download <id> -n playwright-<target>`, then read `error-context.md`
   (a page snapshot). An error page or crash text there means a real bug, even
   when the failure looks like a timeout.
5. **Compare with `docs/ci-flakes.md`.** A match on test and job, not marked
   fixed, is a known flake. A test marked fixed that fails again has a new
   cause: treat it as real.
6. **Known flake:** `gh run rerun <id> --failed`. No need to ask. Poll at short
   intervals and give a real ETA (runs take about 10-14 min); do not wait on
   duplicate checks.
7. **Unknown or real failure:** hand it to `superpowers:systematic-debugging`.
   Fix every failure of the run in one push, and run the full e2e locally
   (`pnpm test:e2e`) before pushing.
8. **New flake confirmed** (failed, passed on rerun, no code cause): add it to
   `docs/ci-flakes.md` (test, job, symptom, seen on, status, what to do).
   Leave the edit uncommitted and tell the maintainer. Never commit it inside
   an unrelated change.

## Stops (OK)

- Pushing a fix, opening or merging a PR: ask the maintainer first.
- Committing the `docs/ci-flakes.md` edit: only if the maintainer asks.
