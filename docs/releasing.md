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

## Once: the Android signing key

Every release also has the phone app, `threadgarden-<version>.apk`, signed
with your Android key. A phone installs an update only when it's signed with
the same key as the app already on it. Create the key once, in a terminal with
Java (`keytool` comes with it):

```sh
keytool -genkeypair -v -keystore threadgarden-android.jks -keyalg RSA -keysize 4096 -validity 10000 -alias threadgarden
```

Choose a password when asked. The keystore keeps the key under that one
password (a PKCS12 keystore, keytool's default), so the key's password is the
same. It also asks for a name, organisation and so on: answer them with
anything.

1. Save `threadgarden-android.jks` itself, the password and the alias
   (`threadgarden`) in your password manager.
2. Make the base64 of the file: `base64 -w0 threadgarden-android.jks` (on
   macOS `base64 -i threadgarden-android.jks`; in PowerShell
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("threadgarden-android.jks"))`).
3. Print the certificate's fingerprint, the line `SHA256:`:
   `keytool -list -v -keystore threadgarden-android.jks -alias threadgarden`.
4. In GitHub (**Settings → Secrets and variables → Actions**), add three
   **secrets**:
   - `ANDROID_KEYSTORE_BASE64`: that base64 text;
   - `ANDROID_KEYSTORE_PASSWORD`: the password;
   - `ANDROID_KEY_PASSWORD`: the password again;

   and, on the **Variables** tab, two variables (they aren't secret):
   - `ANDROID_KEY_ALIAS`: `threadgarden`;
   - `ANDROID_CERT_SHA256`: the fingerprint from step 3. Every release then
     checks the APK is signed by this key. Without it the job only warns.
5. Delete the `.jks` from the PC once it's in the password manager.

Until the three secrets and the alias are there, every release (and
rehearsal) stops at the Android job and stays a draft; the job's error names
the missing ones.

**If the key is ever lost,** phones can't update the app any more: a new key
means a new app as far as Android is concerned. Make a new key as above, release,
and tell users to uninstall the app and install the new APK by hand (they pair
their machines again).

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
2. a **draft** release, then signed builds for Windows, macOS and Linux, the
   headless package (`threadgarden-headless-<version>-linux-x64.tar.gz`, and the
   same as `threadgarden-headless-linux-x64.tar.gz`) and the Windows setup script
   (`threadgarden-setup-worker.ps1`), each with a `.sha256`, and the signed phone
   app (`threadgarden-<version>.apk`), uploaded to it;
3. the update manifest (`latest.json`) and `SHA256SUMS` (every file, the APK
   included), checked;
4. **publish**, only if everything above succeeded.

If anything fails, the release stays a draft (visible only to you under
**Releases**): fix the cause, delete the draft and its tag
(`git push --delete origin v0.3.1`, `git tag -d v0.3.1`), and tag again. The
release notes are generated from the commits since the previous release; edit
them on GitHub afterwards if you like.

Installed apps notice the new version within six hours (or at their next
start) and offer **Restart to update**. The phone app says
"Threadgarden ‹version› is available" when it starts, and **Download** opens
the APK in the browser; Android then asks to install it.

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
