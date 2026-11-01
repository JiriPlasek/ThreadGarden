# Releasing Threadgarden

A release is a pushed tag. GitHub builds and publishes the rest
(`.github/workflows/release.yml`); nothing is built on your PC.

## Once: the signing key

Every release signs its update files, and the installed app accepts only
updates signed with this key. Create it once, in PowerShell in the repository:

```powershell
pnpm --filter desktop tauri signer generate -w "$HOME\.tauri\threadgarden.key"
```

Choose a password when asked. This writes the private key
`threadgarden.key` and the public key `threadgarden.key.pub`.

1. Save the private key file's content **and** the password in your password
   manager.
2. In GitHub: **ThreadGarden → Settings → Secrets and variables → Actions →
   New repository secret**, add `TAURI_SIGNING_PRIVATE_KEY` (the private key
   file's full content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the
   password).
3. Put the public key (the content of `threadgarden.key.pub`) into
   `apps/desktop/src-tauri/tauri.conf.json` → `plugins.updater.pubkey` and
   commit it. It is public.

**If the key is ever lost,** installed copies cannot verify new updates. Make
a new key as above (all three steps), release, and tell users to download and
install that one release by hand; it updates itself again from then on.

## Every release

```sh
pnpm release:version 0.3.1          # writes the version into every file that carries it
git commit -am "chore: release 0.3.1"
git push
git tag v0.3.1
git push origin v0.3.1
```

The tag must match the version (`v` + what `pnpm release:version` wrote), or
the workflow stops before building anything. Then watch **Actions → Release**:

1. CI's checks (lint, types, tests, Rust, end-to-end) on all three systems;
2. a **draft** release, then signed builds for Windows, macOS and Linux and the
   headless package, uploaded to it;
3. the update manifest (`latest.json`) and `SHA256SUMS`, checked;
4. **publish**, only if everything above succeeded.

If anything fails, the release stays a draft (visible only to you under
**Releases**): fix the cause, delete the draft and its tag
(`git push --delete origin v0.3.1`, `git tag -d v0.3.1`), and tag again. The
release notes are generated from the commits since the previous release; edit
them on GitHub afterwards if you like.

Installed apps notice the new version within six hours (or at their next
start) and offer **Restart to update**.

## Rehearsing

To run the whole pipeline without publishing, for example after changing the
workflow: **Actions → Release → Run workflow**, pick the branch, keep
**dry_run** ticked. It builds and checks everything into a draft named
`v<version>-dryrun-<commit>` and deletes the draft at the end. Or from a
terminal:

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

A workflow can only be started by hand once it exists on `main`. To rehearse
a branch that changes the workflow itself, push it to the branch
`release-rehearsal` instead (`git push origin <branch>:release-rehearsal`);
every push there runs a rehearsal. Delete that branch afterwards.
