#!/usr/bin/env bash
# Signs the release APK with the owner's Android key (docs/releasing.md, "Once:
# the Android signing key"). Run by the release workflow:
#
#   scripts/sign-android.sh <unsigned.apk> <signed.apk>
#   scripts/sign-android.sh --check    (only that the secrets are there)
#
# The key and its passwords come from the environment only:
# ANDROID_KEYSTORE_BASE64 (the .jks, base64), ANDROID_KEYSTORE_PASSWORD and
# ANDROID_KEY_PASSWORD (secrets), and ANDROID_KEY_ALIAS (a variable, not secret).
# A missing one stops here, naming it, before anything is built on it, so the
# release stays a draft. No secret is ever printed: the passwords reach apksigner
# as `env:` references, never on its command line, apksigner's own errors stay
# in a log that is deleted, and the keystore is a temporary file, deleted on any
# exit.
#
# Before signing, every native library in the APK must have its LOAD segments
# aligned to 16 KB (phones with 16 KB pages), or it stops. After signing:
# with ANDROID_CERT_SHA256 set, the APK must be signed by that certificate; with
# VERSION set, the APK's versionName must be it.
#
# The SDK's newest build-tools (zipalign, apksigner, aapt2) are used, under
# ANDROID_HOME (or ANDROID_SDK_ROOT), and llvm-readelf from the NDK (NDK_HOME
# or ANDROID_NDK_HOME), else readelf.
#
#   scripts/sign-android.sh --check-alignment <apk>   (only the alignment)
set -euo pipefail

# Fails unless every lib/**/*.so in APK $1 has all its LOAD segments aligned to at least 16 KB.
check_alignment() {
  local apk=$1 dir readelf bad=0 so align
  readelf=$(ls "${NDK_HOME:-${ANDROID_NDK_HOME:-/nonexistent}}"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -n 1 || true)
  if [ -z "$readelf" ]; then readelf=$(command -v llvm-readelf || command -v readelf || true); fi
  if [ -z "$readelf" ]; then
    echo "::error::No readelf to check the native library's alignment (set NDK_HOME)."
    return 1
  fi
  dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/threadgarden-libs.XXXXXX")
  if ! unzip -q -o "$apk" 'lib/*' -d "$dir" 2>/dev/null; then
    rm -rf "$dir"
    echo "::error::$(basename "$apk") has no native library to check."
    return 1
  fi
  while IFS= read -r so; do
    while read -r align; do
      if [ $((align)) -lt $((0x4000)) ]; then
        echo "::error::${so#"$dir"/} has a LOAD segment aligned to $align, below 16 KB: it won't load on a phone with 16 KB pages (see apps/desktop/src-tauri/build.rs)."
        bad=1
        break
      fi
    done < <("$readelf" -lW "$so" | awk '$1 == "LOAD" { print $NF }')
  done < <(find "$dir" -name '*.so')
  rm -rf "$dir"
  return "$bad"
}

check_only=false
if [ $# -eq 1 ] && [ "$1" = "--check" ]; then
  check_only=true
elif [ $# -eq 2 ] && [ "$1" = "--check-alignment" ]; then
  check_alignment "$2"
  echo "Every native library is aligned to 16 KB."
  exit 0
elif [ $# -ne 2 ]; then
  echo "Usage: $0 <unsigned.apk> <signed.apk> | --check | --check-alignment <apk>" >&2
  exit 2
fi

missing=()
for name in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::The Android signing values are missing: ${missing[*]}. Add them as described in docs/releasing.md ('Once: the Android signing key'): ANDROID_KEY_ALIAS is a repository variable, the others are secrets. The release stays a draft."
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
tools=$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -n 1 || true)
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

check_alignment "$unsigned"

# The zip entries: 4-byte alignment, and uncompressed .so files start on 16 KB
# boundaries (-P 16) so they can be mapped from the APK. The library's own
# segments are aligned when it's linked (checked above), not here.
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
  # A fixed hint for each known cause; the log itself is never printed.
  if grep -q 'keystore password was incorrect' "$work/apksigner.log"; then
    hint="ANDROID_KEYSTORE_PASSWORD is not the keystore's password."
  elif grep -q 'does not contain a key' "$work/apksigner.log"; then
    hint="The keystore has no key under the alias in ANDROID_KEY_ALIAS."
  elif grep -qE 'Wrong password\?|Cannot recover key' "$work/apksigner.log"; then
    hint="ANDROID_KEY_PASSWORD is not the key's password (with keytool's default PKCS12 keystore it is the keystore's password)."
  elif grep -qiE 'keystore format|DerInputStream|not a keystore' "$work/apksigner.log"; then
    hint="ANDROID_KEYSTORE_BASE64 is not a keystore: it is the .jks file, base64-encoded."
  else
    hint="Check ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD."
  fi
  echo "::error::The APK could not be signed with the key. $hint"
  rm -f "$signed"
  exit 1
fi
"$tools/apksigner" verify "$signed"

# The owner's own certificate, when its fingerprint is known (docs/releasing.md).
# The first signer's line: "Signer #1 certificate SHA-256 digest: …" up to
# build-tools 36, "V3.0 Signer: certificate SHA-256 digest: …" from 37.
signer=$("$tools/apksigner" verify --print-certs "$signed" |
  awk '/certificate SHA-256 digest: / { print $NF; exit }' | tr -d ':' | tr 'A-F' 'a-f')
if [ -n "${ANDROID_CERT_SHA256:-}" ]; then
  want=$(printf '%s' "$ANDROID_CERT_SHA256" | tr -d ': ' | tr 'A-F' 'a-f')
  if [ "$signer" != "$want" ]; then
    echo "::error::The APK is signed by certificate $signer, not ANDROID_CERT_SHA256 ($want): a phone with the app installed would refuse this update."
    rm -f "$signed"
    exit 1
  fi
else
  echo "::warning::ANDROID_CERT_SHA256 is not set, so the signer isn't checked (it's $signer). Add it as described in docs/releasing.md."
fi

if [ -n "${VERSION:-}" ]; then
  name=$("$tools/aapt2" dump badging "$signed" 2>/dev/null | sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -n 1)
  if [ "$name" != "$VERSION" ]; then
    echo "::error::The APK says version '$name', not $VERSION."
    rm -f "$signed"
    exit 1
  fi
fi
echo "Signed $(basename "$signed")"
