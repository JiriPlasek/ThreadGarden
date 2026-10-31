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
: "${version:?empty VERSION}"
case $version in
  */* | . | ..)
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
  mkdir -p "$tmp"
  cp -R "$src/." "$tmp/"
  rm -rf "${dest:?}"
  mv "$tmp" "$dest"
fi
chmod +x "$dest/bin/threadgarden" "$dest/install.sh"
[ ! -f "$dest/bin/node" ] || chmod +x "$dest/bin/node"
ln -sfn "$dest" "$base/current"
ln -sfn "$base/current/bin/threadgarden" "$HOME/.local/bin/threadgarden"

# Keep this release and the one before it; drop the rest.
for old in "$base"/*; do
  [ -d "$old" ] && [ ! -L "$old" ] || continue
  name=${old##*/}
  [ "$name" != "$version" ] && [ "$name" != "$previous" ] || continue
  rm -rf "$old"
done

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
    trap 'echo "Skipped lingering."' INT
    $SUDO $LOGINCTL enable-linger "$user" ||
      echo "Could not enable lingering; run 'sudo loginctl enable-linger $user' later."
    trap - INT
    ;;
esac

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
