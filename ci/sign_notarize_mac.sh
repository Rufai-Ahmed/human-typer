#!/bin/bash
# Sign + notarize Human Typer.app with the company's Apple Developer ID, in CI.
#
# Graceful degradation (so builds never break):
#   - No cert secret set        -> UNSIGNED build (current behaviour; Gatekeeper warns).
#   - Cert but no API key set    -> SIGNED but NOT notarized (stable identity, still warns).
#   - Cert + API key set         -> SIGNED + NOTARIZED + STAPLED (no Gatekeeper warning).
#
# Required GitHub Secrets for full notarization:
#   APPLE_DEV_ID_CERT_P12        base64 of the "Developer ID Application" .p12
#   APPLE_DEV_ID_CERT_PASSWORD   password used when exporting that .p12
#   APPLE_API_KEY_P8             base64 of the App Store Connect API key (AuthKey_XXXX.p8)
#   APPLE_API_KEY_ID             that key's Key ID
#   APPLE_API_ISSUER_ID          the App Store Connect Issuer ID
# Optional:
#   APPLE_DEV_ID_IDENTITY        full identity string, e.g.
#                                "Developer ID Application: Company (TEAMID)".
#                                Auto-detected from the cert if omitted.
set -euo pipefail

APP="${1:-dist/Human Typer.app}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$HERE/entitlements.mac.plist"

have() { [ -n "${!1:-}" ]; }

if ! have APPLE_DEV_ID_CERT_P12; then
  echo "==> No Developer ID cert secret set — shipping an UNSIGNED build."
  echo "    (Gatekeeper will warn buyers. Add APPLE_DEV_ID_CERT_P12 etc. to notarize.)"
  exit 0
fi

if [ ! -d "$APP" ]; then
  echo "ERROR: app bundle not found at: $APP" >&2
  exit 1
fi

: "${RUNNER_TEMP:=$(mktemp -d)}"

echo "==> Importing Developer ID certificate into a temporary keychain"
KEYCHAIN="$RUNNER_TEMP/htsign.keychain-db"
KEYCHAIN_PW="$(openssl rand -base64 24)"
security create-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PW" "$KEYCHAIN"
security default-keychain -s "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN"

CERT_P12="$RUNNER_TEMP/devid.p12"
echo "$APPLE_DEV_ID_CERT_P12" | base64 --decode > "$CERT_P12"
security import "$CERT_P12" -k "$KEYCHAIN" -P "${APPLE_DEV_ID_CERT_PASSWORD:-}" \
  -T /usr/bin/codesign
# Allow codesign to use the key without an interactive prompt.
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PW" "$KEYCHAIN" >/dev/null

IDENTITY="${APPLE_DEV_ID_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" \
    | grep 'Developer ID Application' | head -1 | sed -E 's/.*"(.*)".*/\1/')"
fi
if [ -z "$IDENTITY" ]; then
  echo "ERROR: no 'Developer ID Application' identity found in the imported cert." >&2
  security find-identity -v -p codesigning "$KEYCHAIN" || true
  exit 1
fi
echo "==> Signing as: $IDENTITY"

# Sign every Mach-O binary inside-out with hardened runtime + entitlements, then
# the bundle itself. (--deep is unreliable for notarization, so we walk it.)
while IFS= read -r f; do
  if file -b "$f" | grep -q 'Mach-O'; then
    codesign --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$f"
  fi
done < <(find "$APP/Contents" -type f)

codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"

echo "==> Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP"

if ! have APPLE_API_KEY_P8; then
  echo "==> Signed, but no App Store Connect API key set — SKIPPING notarization."
  echo "    (Add APPLE_API_KEY_P8 / APPLE_API_KEY_ID / APPLE_API_ISSUER_ID to notarize.)"
  exit 0
fi

echo "==> Notarizing (Apple's notary service; usually 1-5 min)"
API_KEY="$RUNNER_TEMP/AuthKey.p8"
echo "$APPLE_API_KEY_P8" | base64 --decode > "$API_KEY"
NOTARIZE_ZIP="$RUNNER_TEMP/notarize.zip"
ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
xcrun notarytool submit "$NOTARIZE_ZIP" \
  --key "$API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" \
  --wait

echo "==> Stapling the notarization ticket onto the app"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
# Final gate check (informational): how Gatekeeper will judge it on a buyer's Mac.
spctl -a -vvv --type exec "$APP" || true

echo "==> Done — $APP is signed & notarized."
