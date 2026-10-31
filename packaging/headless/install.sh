#!/bin/sh
# Installs this Threadgarden headless release for the current user. Idempotent:
# running a newer release's install.sh upgrades `current` to it.
# Needs no root, except one `loginctl enable-linger` (explained below).
set -eu

SYSTEMCTL=${SYSTEMCTL-systemctl}
LOGINCTL=${LOGINCTL-loginctl}
SUDO=${SUDO-sudo}

src=$(cd "$(dirname "$0")" && pwd)
version=$(cat "$src/VERSION")
user=${USER:-$(id -un)}
base=$HOME/.local/share/threadgarden-headless
unit_dir=$HOME/.config/systemd/user

echo "Installing Threadgarden headless $version"

mkdir -p "$base" "$HOME/.local/bin" "$unit_dir"

# Copy the release next to its siblings; `current` points at the newest one.
rm -rf "${base:?}/$version"
mkdir -p "$base/$version"
cp -R "$src/." "$base/$version/"
chmod +x "$base/$version/bin/threadgarden" "$base/$version/install.sh"
[ ! -f "$base/$version/bin/node" ] || chmod +x "$base/$version/bin/node"
ln -sfn "$base/$version" "$base/current"
ln -sfn "$base/current/bin/threadgarden" "$HOME/.local/bin/threadgarden"

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
    $SUDO $LOGINCTL enable-linger "$user" ||
      echo "Could not enable lingering; run 'sudo loginctl enable-linger $user' later."
    ;;
esac

echo
echo "Running: systemctl --user daemon-reload"
$SYSTEMCTL --user daemon-reload
echo "Running: systemctl --user enable --now threadgarden"
$SYSTEMCTL --user enable --now threadgarden
# An upgrade leaves the old process running until it is restarted.
$SYSTEMCTL --user restart threadgarden

echo
echo "Installed. Make sure ~/.local/bin is on your PATH, then pair this machine"
echo "with your desktop:"
echo "  threadgarden pair"
