# Releases and self-update

**Date:** 2026-11-01
**Status:** Agreed with the owner in conversation on 2026-11-01 ("everything aligns"). Calls marked *(designer's call)* were made without the owner; *(builder's call)* marks what is left to whoever plans and builds it.
**Builds on:** the CI workflow (`.github/workflows/ci.yml`), which already builds unsigned installers on Windows, macOS and Linux and the `threadgarden-headless` Linux package on every push.

## 1. Intent

Installing Threadgarden today means building it yourself or digging an installer out of a CI run that expires after 7 days. The owner wants a **normal app install**: a stable download, and an app that keeps itself up to date. The repository is public (`JiriPlasek/ThreadGarden`), so others may install it too.

## 2. What the owner agreed

- **Installing:** download one file from the repository's **GitHub Releases** page and run it: `Threadgarden_<version>_x64-setup.exe` (and MSI) on Windows, DMG on macOS, deb/rpm/AppImage on Linux. Stable links, no expiry.
- **Updating:** like most desktop apps. Threadgarden notices a newer release, shows a quiet "Update available, restart to install", and updates itself when the owner says so.
- **Releasing:** bump the version and push a tag such as `v0.3.0`; GitHub builds everything on all three systems and publishes the release with notes generated from the history. Nothing is built on the owner's PC.
- **Ubuntu PC:** its setup downloads the `threadgarden-headless` package from the latest release with one command. Updating it stays manual (re-run `install.sh`); "Update Ubuntu PC" from the desktop is planned separately (remote machines plan 3).
- **Left out:** paid code signing (SmartScreen and Gatekeeper keep warning on first install), app stores, Homebrew, winget.
- **Updates are signed:** each update is signed with a private key kept as a GitHub Actions secret; the app ships the public key and installs only updates signed with it.

## 3. Goals, non-goals, anti-goals

**Goals**
- A release workflow triggered by pushing a `v*` tag that publishes one GitHub Release with every installer, the headless package, update metadata, signatures and checksums.
- In-app update check, notice and install-on-consent, on Windows and macOS, and on Linux for the AppImage.
- One command to set the version everywhere it lives.
- Stable, versionless download URLs for the latest headless package and its checksum.
- Docs: README install from Releases; a short "how to release" for the owner; the remote-machines guide downloads from the latest release.

**Non-goals**
- Code signing / notarization; app stores; Homebrew/winget/apt repositories.
- Updating the headless service (manual `install.sh` for now; desktop-driven updates are remote-machines plan 3).
- Beta/nightly channels, delta updates, rollbacks beyond "install the previous release by hand".
- Self-update of the deb and rpm packages (the updater cannot replace system-package installs): those users see the notice with a download link instead.

**Anti-goals** (would make it a failure even if it works)
- An update stops running agents or loses work without the owner agreeing first (v1 anti-goal: never lose work).
- The app installs anything not signed with the project's key.
- A half-published release (some platforms missing, or metadata pointing at files that are not there).
- The update check slows the app or nags: no modal on start, no repeated popups.
- Threadgarden contacts anything other than GitHub for updates (the privacy section lists every outbound connection; this adds exactly one).

## 4. Release workflow

- New workflow `.github/workflows/release.yml`, triggered by pushing a tag matching `v*`. The tag must equal `v` + the version in the repo (checked first; mismatch fails the run before building).
- It runs the same checks as CI (or requires the tagged commit's CI to be green; *(builder's call)* which, as long as a release can never publish from a failing commit).
- Build matrix as the CI `bundle` job (Windows x64, macOS arm64, Linux x64) plus the headless package (Linux x64), with updater artifacts enabled and signed using the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **No half releases:** create the release as a **draft**, upload every asset from every job, generate the update manifest (`latest.json`, Tauri's format) only after all platform jobs succeeded, then publish. Any job failing leaves a draft (or nothing) and no published release *(designer's call)*.
- Release notes: GitHub's generated notes from the history since the previous tag *(designer's call)*; the owner can edit them on GitHub afterwards.
- Assets on every release:
  - desktop: NSIS `setup.exe` and MSI (Windows), DMG (macOS), deb, rpm and AppImage (Linux), plus the updater bundles and their `.sig` files;
  - `latest.json` (update manifest);
  - `threadgarden-headless-<version>-linux-x64.tar.gz` and `.sha256`, **and** versionless copies `threadgarden-headless-linux-x64.tar.gz` and `.sha256` so `https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/threadgarden-headless-linux-x64.tar.gz` always works *(designer's call)*;
  - `SHA256SUMS` over all assets *(designer's call)*.
- The existing CI workflow keeps building unsigned artifacts on every push for testing; releases come only from tags.

## 5. Versioning

- One command (e.g. `pnpm release:version 0.3.0`) writes the version into every file `apps/desktop/tests/versions.test.ts` checks (root, desktop, service and protocol `package.json`, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`), so the test keeps them in sync *(builder's call how)*.
- Semantic versions; tags `vX.Y.Z`. The first release is 0.3.0 (§9).
- The owner's release routine, documented in `docs/releasing.md`: run the version command, commit, push, tag `vX.Y.Z`, push the tag; watch the release workflow; edit the notes if wanted.

## 6. Self-update in the app

- Tauri 2's updater plugin (and the process plugin for the relaunch) with the public key in the app config and one endpoint: `https://github.com/JiriPlasek/ThreadGarden/releases/latest/download/latest.json`.
- **When it checks:** shortly after start, then every 6 hours while running *(designer's call)*; a failed check (offline, GitHub down) is silent and retried at the next interval. Settings shows the current version, the last check, and a **Check for updates** button.
- **How it tells:** a small, dismissible notice ("Threadgarden 0.3.0 is available. Restart to update.") in the bottom strip, with a link to the release notes; also in Settings. No modal, no repeated popups; dismissing hides it until the next version *(designer's call)*.
- **Installing:** on **Restart to update**:
  1. If chats are running or scheduled sends are pending on This PC, confirm first, naming them, because updating restarts the local service and stops them. Chats stopped this way are resumable, as after any service restart. Remote machines are unaffected.
  2. Download and verify the update (signature against the bundled public key). A failed verification aborts with a message and changes nothing.
  3. Stop the local service (as **Quit Threadgarden completely** does), so the installer can replace the bundled runtime and the service bundle.
  4. Install and relaunch. The new app starts the new service as usual.
- **Linux deb/rpm:** the notice offers **Download** (opens the release page) instead of Restart to update.
- **Privacy:** the README's network section gains this one outbound request (to GitHub, for the manifest and the update file); nothing is sent beyond the request itself.
- The browser/mock UI (Playwright) has no updater; the notice must be testable with a stubbed check *(builder's call how)*.

## 7. Signing key

- Generated once by the owner with Tauri's signer tool (an encrypted minisign key + password, §9). The private key and password go into the repository's Actions secrets; the public key into the app config (committed). The existing CI `bundle` job keeps building **unsigned** without updater artifacts: the updater settings live in a release-only config overlay, so pushes without the secrets keep working *(designer's call)*.
- The owner keeps a backup of the private key and password outside GitHub, in a password manager (§9). If the key is ever lost, existing installs cannot verify new updates: users must download and install one release by hand, after which a new key is in effect.

## 8. Docs

- README "Install": download from the Releases page (latest), what each file is for, first-launch warnings; self-update in one sentence; building from source stays below.
- `docs/remote-machines.md`: the headless download becomes the stable latest-release URL (curl + `sha256sum -c`); the CI-artifact route is removed (or kept as a fallback for testing unreleased branches) *(designer's call: keep as a short fallback note)*.
- `docs/releasing.md` (new): the owner's release routine and the signing key's care.

## 9. Owner decisions after review (2026-11-01)

1. **First version: 0.3.0** (below 1.0: still experimental). The README's "v1.3" status line becomes the released version.
2. **No test tags on the public repo:** releases are real from the start. **0.3.0 is the first live proof** of the pipeline, and a small **0.3.1** right after it proves the self-update end to end (0.3.0 installs 0.3.1). Before the first tag, everything that can be checked without publishing is checked: the workflow on a branch up to (not including) publishing, the signed update bundles and `latest.json` produced and validated, and the in-app updater against a local manifest *(builder's call how)*.
3. **The owner creates the signing key and secrets.** The plan gives exact commands: generate the key with Tauri's signer (the owner picks the password), add the secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the repository's Actions settings, keep a backup of both in a password manager; the builder commits the public key the owner hands over. This is a manual prerequisite step before the first tag.
4. The release workflow declares `permissions: contents: write` for its token *(designer's call; the repo is a personal one, so nothing restricts it)*.

## 10. Calls made without the owner (for review)

- Draft-then-publish, manifest generated last (no half releases) (§4).
- Generated release notes (§4).
- Versionless headless asset names for a stable latest URL; a SHA256SUMS file (§4).
- Check on start + every 6 hours; silent failures; dismissible notice in the strip; no modal (§6).
- Confirm before updating when work is running on This PC; stop the local service before installing (§6).
- deb/rpm get a Download link rather than self-update (§6).
- Keep a short CI-artifact fallback note in the remote-machines guide (§8).
