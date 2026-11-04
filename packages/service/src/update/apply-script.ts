/**
 * The last step of a machine's update: a shell script that installs the release,
 * waits for the new service to start, and goes back to the old version if it
 * doesn't. It has to be a script: the install restarts the service that started it.
 */

/**
 * Plain lines rather than a template literal, so nothing in the shell source can
 * ever be read as a JS interpolation. Values reach it only as arguments, see `applyArgs`.
 *
 * It finds out that the new version started from `last.json`, written by that
 * version's `reconcile()`: `state` and `version` must be there with those exact keys.
 */
export const APPLY_SCRIPT = [
  '#!/bin/sh',
  '# Applies an unpacked release: runs its install.sh, waits for the new service to',
  '# say it started, and otherwise goes back to the version it came from. It runs in',
  '# its own systemd unit, so it outlives the restart that replaces the service, and',
  "# nobody is at this machine's screen. So no `set -e`: every failure has to reach",
  '# the rollback, and a step of the rollback that fails must not stop the next one.',
  '',
  'installSh=$1',
  'version=$2',
  'from=$3',
  'installBase=$4',
  'updateDir=$5',
  'timeoutS=$6',
  '',
  'SYSTEMCTL=${SYSTEMCTL-systemctl}',
  '',
  'last=$updateDir/last.json',
  '',
  '# Whether the new service has written that this version started. Whitespace is',
  '# dropped first, and the patterns compare literally: a dot in a version is a dot.',
  'started() {',
  '  [ -f "$last" ] || return 1',
  '  status=$(tr -d \'[:space:]\' < "$last")',
  '  case $status in',
  '    *\'"state":"done"\'*) ;;',
  '    *) return 1 ;;',
  '  esac',
  '  case $status in',
  '    *"\\"version\\":\\"$version\\""*) return 0 ;;',
  '    *) return 1 ;;',
  '  esac',
  '}',
  '',
  '# Replaced in one step: the service reads this file and must never see half of it.',
  'write_failed() {',
  '  tmp=$last.$$.tmp',
  '  if printf \'{"state":"failed","version":"%s","from":"%s","reason":"%s"}\\n\' "$version" "$from" "$1" > "$tmp"; then',
  '    mv -f "$tmp" "$last"',
  '  else',
  '    rm -f "$tmp"',
  '  fi',
  '}',
  '',
  'roll_back() {',
  "  # First, so a slow new service can't write its outcome over this one.",
  '  $SYSTEMCTL --user stop threadgarden',
  '  # A link to a directory that is gone would stop any service from starting, so',
  '  # then the new version stays: it may be broken, but it is the only one left.',
  '  if [ -d "$installBase/$from" ]; then',
  '    ln -sfn "$installBase/$from" "$installBase/current"',
  '  fi',
  "  # install.sh has already put the new release's unit in place. It may be what",
  '  # broke, or start the old version with flags that version rejects.',
  '  if [ -f "$installBase/$from/threadgarden.service" ]; then',
  '    cp "$installBase/$from/threadgarden.service" "$HOME/.config/systemd/user/threadgarden.service"',
  '  fi',
  '  $SYSTEMCTL --user daemon-reload',
  '  # Before the restart: the restored service reads both files as it starts, and',
  '  # with a pending update for another version it would report the wrong state.',
  '  write_failed "$1"',
  '  rm -f "$updateDir/pending.json"',
  '  $SYSTEMCTL --user restart threadgarden',
  '  exit 1',
  '}',
  '',
  '# What an earlier update left must not speak for this one: its done would pass',
  '# for this version having started, whether it did or not.',
  'rm -f "$last" "$updateDir/skipped"',
  '',
  '# sudo -n: nobody can type a password here, so a sudo step fails and is named as',
  '# skipped, rather than wait for ever.',
  'if ! SUDO="sudo -n" THREADGARDEN_SKIPPED_FILE="$updateDir/skipped" sh "$installSh" > "$updateDir/install.log" 2>&1; then',
  '  roll_back install',
  'fi',
  '',
  '# A timeout that is not a number fails the test, and so rolls back: never a loop',
  '# without an end.',
  'waited=0',
  'until started; do',
  '  [ "$waited" -lt "$timeoutS" ] || roll_back start',
  '  sleep 1',
  '  waited=$((waited + 1))',
  'done',
  'exit 0',
  '',
].join('\n');

export interface ApplyOptions {
  /** The install.sh of the unpacked new release. */
  installSh: string;
  version: string;
  /** The version running now, which a failed update goes back to. */
  from: string;
  /** The directory holding the release directories and the `current` link. */
  installBase: string;
  /** `<dataDir>/update`: pending.json, last.json, skipped and install.log live there. */
  updateDir: string;
  /** How long the new service gets to report that it started. */
  timeoutS?: number;
}

/** The arguments `APPLY_SCRIPT` takes, in its order. */
export const applyArgs = ({
  installSh,
  version,
  from,
  installBase,
  updateDir,
  timeoutS = 90,
}: ApplyOptions): string[] => [installSh, version, from, installBase, updateDir, String(timeoutS)];
