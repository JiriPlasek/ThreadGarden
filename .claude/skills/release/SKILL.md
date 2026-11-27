---
name: release
description: Use when asked to cut or publish a Threadgarden release (a new vX.Y.Z), or to recover a failed release run. Follows docs/releasing.md.
---

# Release

Source of truth: `docs/releasing.md`. A release is a pushed tag; GitHub builds
and publishes. Steps marked (OK) need the maintainer's explicit approval.

If the project's notes say merges need a local merge (missing token scopes),
follow them. Run `gh` as the repo maintainer.

## Checklist

1. **Preconditions.** On up-to-date `main` (`git fetch origin`), clean tree,
   CI green on `main`, and the intended PRs all merged. If not, stop and say
   what is missing.
2. **Propose a version.** Read the commits since the last tag
   (`git log <last-tag>..origin/main --oneline`), propose X.Y.Z (feat means
   minor, fixes only means patch) and wait for the maintainer to confirm it.
3. **Prepare.** Branch `chore/release-X.Y.Z` off `origin/main`. Check whether
   `.github/workflows/release.yml` changed since the last tag:
   `git diff <last-tag> origin/main -- .github/workflows/release.yml`.
4. **Bump.** `pnpm release:version X.Y.Z`. Run `git status`, then commit only
   the files it wrote: `git add -u -- <those paths>` and
   `git commit -m "chore: release X.Y.Z"`. Leave any uncommitted
   `docs/ci-flakes.md` edit out of the release commit.
5. **Verify locally.** Run the full e2e before pushing: `pnpm test:e2e`.
6. **Dry run, only if `release.yml` changed since the last tag.**
   `gh workflow run release.yml --ref <branch> -f dry_run=true`. It includes
   the full CI, so do not also wait on the PR's duplicate checks. A workflow
   can be started by hand only once it exists on `main`; to rehearse a branch
   that changes it, `git push origin <branch>:release-rehearsal` and delete
   that branch afterwards.
7. **(OK) Open the release PR.** Push the branch, then `gh pr create`. Release
   PRs skip most CI by design.
8. **Wait for CI** (and the dry run, if one was started) to finish green
   before merging. On any failure, use `/ci-triage`.
9. **(OK) Merge** the PR (locally, if the notes require it). Then
   `git fetch origin` and confirm `origin/main` is the merge commit.
10. **(OK) Push the tag** on the merge commit on main:
    `git tag vX.Y.Z <merge-commit>`, `git push origin vX.Y.Z`. The tag must
    equal `v` plus the version `pnpm release:version` wrote, or the workflow
    stops before building.
11. **Watch Actions, Release.** About 10-14 minutes: poll at short intervals
    and give a real ETA. On a failure, read every failure of the run and fix
    them together. `gh run rerun <id> --failed` re-runs the failed job and the
    dependent jobs it skipped (no approval needed). If the fix needs a new
    commit, the draft and tag must be deleted first
    (`git push --delete origin vX.Y.Z`, `git tag -d vX.Y.Z`) and the tag pushed
    again (OK).
12. **Check the result.** `gh release view vX.Y.Z --json assets` lists every
    expected file. Fetch `latest.json` from the release's download URL and check
    its `version` is X.Y.Z and each platform has a signature.
13. **(OK) Cleanup.** Delete the release branch (and `release-rehearsal`, if
    used) and any worktrees you created.
14. **After publishing,** update the project's to-do notes if the project's
    CLAUDE.md asks for it.
