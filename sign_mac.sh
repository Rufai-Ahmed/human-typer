#!/bin/bash
# Sign Human Typer.app with a STABLE self-signed identity.
#
# Why: ad-hoc signatures (PyInstaller's default) change on every build, so macOS
# treats each rebuild as a new app and forgets your Accessibility / Input
# Monitoring grants. A stable identity keeps the grant across rebuilds & updates.
#
# Run once (it creates the identity), then after each build:  ./sign_mac.sh
# For SELLING to others, prefer a real Apple Developer ID (also enables
# notarization and removes the Gatekeeper warning). This self-signed cert only
# makes grants persist on machines where it's installed.
set -e
cd "$(dirname "$0")"
APP="dist/Human Typer.app"
IDENTITY="Human Typer Self-Signed"

if [ ! -d "$APP" ]; then
    echo "No $APP — run ./build_mac.sh first."; exit 1
fi

if ! security find-identity -v -p codesigning | grep -q "$IDENTITY"; then
    echo "Creating self-signed code-signing identity '$IDENTITY'..."
    TMP="$(mktemp -d)"
    cat > "$TMP/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cfg" 2>/dev/null
    # macOS's `security` tool needs a legacy-format PKCS#12 with a non-empty
    # password (modern OpenSSL's default p12 fails MAC verification on import).
    P12PW="humantyper"
    openssl pkcs12 -export -legacy -macalg sha1 \
        -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES \
        -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout "pass:$P12PW" 2>/dev/null \
      || openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout "pass:$P12PW"
    # -A lets codesign use the key without a per-use access prompt.
    security import "$TMP/id.p12" -k ~/Library/Keychains/login.keychain-db -P "$P12PW" -A
    rm -rf "$TMP"
    echo "Identity created (valid 10 years)."
fi

echo "Signing $APP ..."
codesign --force --deep --sign "$IDENTITY" "$APP"
echo "Verifying signature:"
codesign -dv "$APP" 2>&1 | grep -iE "Authority|Identifier|Signature" || true
echo ""
echo "Done. Grant Accessibility + Input Monitoring ONCE; it now persists across rebuilds."
