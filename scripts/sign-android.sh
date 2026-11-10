#!/usr/bin/env bash
# Signs the release APK with the owner's Android key (docs/releasing.md, "Once:
# the Android signing key"). Run by the release workflow:
#
#   scripts/sign-android.sh <unsigned.apk> <signed.apk>
#   scripts/sign-android.sh --check    (only that the secrets are there)
#
# The key and its passwords come from the environment only:
# ANDROID_KEYSTORE_BASE64 (the .jks, base64), ANDROID_KEYSTORE_PASSWORD,
# ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. A missing one stops here, naming
# it, before anything is built on it, so the release stays a draft. No value is
# ever printed: the passwords reach apksigner as `env:` references, never on its
# command line, and the keystore is a temporary file, deleted on any exit.
# The SDK's newest build-tools (zipalign, apksigner) are used, under
# ANDROID_HOME (or ANDROID_SDK_ROOT).
set -euo pipefail

check_only=false
if [ $# -eq 1 ] && [ "$1" = "--check" ]; then
  check_only=true
elif [ $# -ne 2 ]; then
  echo "Usage: $0 <unsigned.apk> <signed.apk> | --check" >&2
  exit 2
fi

missing=()
for name in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::The Android signing secrets are missing: ${missing[*]}. Add them as described in docs/releasing.md ('Once: the Android signing key'). The release stays a draft."
  exit 1
fi
if [ "$check_only" = true ]; then
  echo "The Android signing secrets are there."
  exit 0
fi
unsigned=$1
signed=$2

if [ ! -f "$unsigned" ]; then
  echo "::error::No APK to sign at $unsigned."
  exit 1
fi

sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
tools=$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1)
if [ -z "$sdk" ] || [ -z "$tools" ] || [ ! -x "$tools/apksigner" ]; then
  echo "::error::No Android build-tools (zipalign, apksigner) under ANDROID_HOME."
  exit 1
fi

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/threadgarden-sign.XXXXXX")
# The keystore never outlives this script, whatever happens.
trap 'rm -rf "$work"' EXIT
keystore="$work/release.jks"
(umask 077 && printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$keystore") 2>/dev/null || {
  echo "::error::ANDROID_KEYSTORE_BASE64 is not valid base64 (it is the .jks file, base64-encoded)."
  exit 1
}

# 16 KB page alignment for the native library (Android 15+ devices with 16 KB pages).
"$tools/zipalign" -P 16 -f 4 "$unsigned" "$work/aligned.apk"
mkdir -p "$(dirname "$signed")"
# apksigner's own errors name the alias and the keystore: they stay in the work folder.
# No v4 signature: that is a separate .idsig file, only for adb's incremental installs.
if ! "$tools/apksigner" sign \
  --ks "$keystore" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD \
  --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --key-pass env:ANDROID_KEY_PASSWORD \
  --v4-signing-enabled false \
  --out "$signed" \
  "$work/aligned.apk" > "$work/apksigner.log" 2>&1; then
  echo "::error::The APK could not be signed with the key: check ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD (with a PKCS12 keystore, keytool's default, the key's password is the keystore's)."
  rm -f "$signed"
  exit 1
fi
"$tools/apksigner" verify "$signed"
echo "Signed $(basename "$signed")"
