#!/bin/sh
# Installs this Threadgarden headless release for the current user. Idempotent:
# running a newer release's install.sh upgrades `current` to it, and running the
# installed copy again just refreshes the links, the unit and the service.
# Needs no root, except one `loginctl enable-linger` (explained below).
set -eu

SYSTEMCTL=${SYSTEMCTL-systemctl}
LOGINCTL=${LOGINCTL-loginctl}
SUDO=${SUDO-sudo}

if [ "$(id -u)" -eq 0 ]; then
  echo "Run install.sh as your own user, not root." >&2
  exit 1
fi

# The service runs under the user's systemd manager; without one there is nothing to enable.
if ! $SYSTEMCTL --user show-environment >/dev/null 2>&1; then
  echo "The systemd user manager is not available (is systemd running, and are you logged in" >&2
  echo "with a session, e.g. over ssh rather than su?). Nothing was installed." >&2
  exit 1
fi

src=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
version=$(cat "$src/VERSION")
if [ -z "$version" ]; then
  echo "Empty VERSION." >&2
  exit 1
fi
# It becomes a directory name: letters, digits and . + _ - only, no leading dot.
case $version in
  *[!A-Za-z0-9.+_-]* | .*)
    echo "Invalid VERSION '$version'." >&2
    exit 1
    ;;
esac
user=${USER:-$(id -un)}
base=$HOME/.local/share/threadgarden-headless
unit_dir=$HOME/.config/systemd/user

echo "Installing Threadgarden headless $version"

mkdir -p "$base" "$HOME/.local/bin" "$unit_dir"

# The version `current` points at now, kept as the rollback target.
previous=$(readlink "$base/current" 2>/dev/null || true)
previous=${previous##*/}

dest=$base/$version
if [ "$(CDPATH= cd -- "$dest" 2>/dev/null && pwd -P || true)" != "$src" ]; then
  # Copy aside, then swap in, so a failed copy never leaves a half release.
  tmp=$base/.$version.tmp.$$
  rm -rf "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp"
  cp -R "$src/." "$tmp/"
  rm -rf "${dest:?}"
  mv "$tmp" "$dest"
  trap - EXIT
fi
chmod +x "$dest/bin/threadgarden" "$dest/install.sh"
[ ! -f "$dest/bin/node" ] || chmod +x "$dest/bin/node"
ln -sfn "$dest" "$base/current"
ln -sfn "$base/current/bin/threadgarden" "$HOME/.local/bin/threadgarden"

# Copies an earlier run left half-done.
for stale in "$base"/.*.tmp.*; do
  if [ -d "$stale" ]; then rm -rf "$stale"; fi
done
# Keep this release and the one before it; drop the rest. Reinstalling the
# current version (previous == version) must not cost the rollback, so it prunes nothing.
if [ "$previous" != "$version" ]; then
  for old in "$base"/*; do
    [ -d "$old" ] && [ ! -L "$old" ] || continue
    name=${old##*/}
    [ "$name" != "$version" ] && [ "$name" != "$previous" ] || continue
    rm -rf "$old"
  done
fi

cp "$src/threadgarden.service" "$unit_dir/threadgarden.service"

# A user unit only runs while the user is logged in, unless lingering is on.
linger=$($LOGINCTL show-user "$user" -p Linger 2>/dev/null || true)
case $linger in
  Linger=yes) ;;
  *)
    echo
    echo "Threadgarden runs as a systemd user service. Such a service stops when you"
    echo "log out and does not start at boot, unless lingering is enabled for your"
    echo "account. To make it start at boot, this runs once:"
    echo "  sudo loginctl enable-linger $user"
    echo "(it may ask for your password; skip it with Ctrl+C and the service will"
    echo "only run while you are logged in)."
    # Ctrl+C reaches the whole process group; only the sudo child should die.
    skipped=0
    trap 'skipped=1; echo "Skipped lingering."' INT
    $SUDO $LOGINCTL enable-linger "$user" || {
      [ "$skipped" = 1 ] ||
        echo "Could not enable lingering; run 'sudo loginctl enable-linger $user' later."
    }
    trap - INT
    ;;
esac

# Idle shutdown runs `systemctl poweroff` from the user service. Without a rule
# polkit refuses that to a user session that is not at the console.
polkit_rules_dir=${POLKIT_RULES_DIR:-/etc/polkit-1/rules.d}
polkit_rule=$polkit_rules_dir/49-threadgarden-power.rules

polkit_rule_text() {
  cat <<EOF
// Lets the Threadgarden service of $user power the machine off (idle shutdown).
polkit.addRule(function (action, subject) {
  if ((action.id == "org.freedesktop.login1.power-off" ||
       action.id == "org.freedesktop.login1.power-off-multiple-sessions") &&
      subject.user == "$user") {
    return polkit.Result.YES;
  }
});
EOF
}

echo
if [ ! -d "$polkit_rules_dir" ]; then
  echo "This system has no polkit rules directory ($polkit_rules_dir), so it is" >&2
  echo "probably too old for JavaScript rules. Threadgarden won't be able to power" >&2
  echo "this machine off for idle shutdown; everything else works." >&2
elif [ "$(cat "$polkit_rule" 2>/dev/null || true)" = "$(polkit_rule_text)" ]; then
  echo "The rule that lets Threadgarden power this machine off is already in place."
else
  echo "Threadgarden can shut this machine down when it has been idle, and a"
  echo "power switch can then cut its power. Powering off from a user service"
  echo "needs a polkit rule that allows it for your account only. To add it,"
  echo "this runs once:"
  echo "  sudo tee $polkit_rule"
  echo "  sudo chmod 644 $polkit_rule"
  echo "(it may ask for your password; skip it with Ctrl+C and idle shutdown will"
  echo "fail to power the machine off)."
  skipped=0
  trap 'skipped=1; echo "Skipped the power-off rule; idle shutdown will fail to power the machine off."' INT
  {
    polkit_rule_text | $SUDO tee "$polkit_rule" >/dev/null && $SUDO chmod 644 "$polkit_rule"
  } || {
    [ "$skipped" = 1 ] ||
      echo "Could not write $polkit_rule; idle shutdown will fail to power the machine off."
  }
  trap - INT
fi

echo
echo "Running: systemctl --user daemon-reload"
$SYSTEMCTL --user daemon-reload
echo "Running: systemctl --user enable threadgarden"
$SYSTEMCTL --user enable threadgarden
# Starts it, or restarts it so an upgrade takes effect.
echo "Running: systemctl --user restart threadgarden"
$SYSTEMCTL --user restart threadgarden

echo
echo "Installed. Make sure ~/.local/bin is on your PATH, then pair this machine"
echo "with your desktop:"
echo "  threadgarden pair"
echo
echo "The service's PATH is ~/.local/bin:/usr/local/bin:/usr/bin:/bin; if \`claude\` lives"
echo "elsewhere, run 'systemctl --user edit threadgarden' and add an Environment=PATH=... override."
