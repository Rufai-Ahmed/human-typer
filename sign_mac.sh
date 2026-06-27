#!/bin/bash
# Sign Human Typer.app with a STABLE self-signed identity.
#
# Why: ad-hoc signatures (PyInstaller's default) change on every build, so macOS
# treats each rebuild as a brand-new app and forgets your Accessibility / Input
# Monitoring grants. ONE stable identity keeps those grants across rebuilds.
#
# Self-healing: earlier versions checked `find-identity -v` (valid-only). A
# self-signed cert is untrusted, so -v hid it; the script thought none existed and
# created a fresh duplicate every build. That left several identical, untrusted
# "Human Typer Self-Signed" certs, which made `codesign --sign <name>` AMBIGUOUS
# and silently fall back to ad-hoc. This version lists WITHOUT -v, collapses the
# duplicates to one, and signs by the identity's SHA-1 HASH (never the name).
set -e
cd "$(dirname "$0")"
APP="dist/Human Typer.app"
IDENTITY="Human Typer Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [ ! -d "$APP" ]; then
    echo "No $APP — run ./build_mac.sh first."; exit 1
fi

# SHA-1 hashes of every code-signing identity with this name, sorted+deduped so the
# pick is deterministic across builds even if a stray duplicate ever lingers.
list_hashes() {
    security find-identity -p codesigning 2>/dev/null \
        | grep "$IDENTITY" | grep -oE '[[:xdigit:]]{40}' | sort -u
}

create_identity() {
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
    # -A: no per-use key-access prompt;  -T /usr/bin/codesign: let codesign use it.
    security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$P12PW" -A -T /usr/bin/codesign
    rm -rf "$TMP"
}

# Collapse to EXACTLY ONE identity: if there isn't exactly one, purge every
# duplicate cert by hash, then create a single fresh one.
count="$(list_hashes | wc -l | tr -d ' ')"
if [ "$count" != "1" ]; then
    if [ "$count" != "0" ]; then
        echo "Found $count '$IDENTITY' identities — collapsing to one..."
        for h in $(list_hashes); do
            security delete-certificate -Z "$h" "$KEYCHAIN" 2>/dev/null || true
        done
    fi
    create_identity
fi

HASH="$(list_hashes | head -1)"
if [ -z "$HASH" ]; then
    echo "Could not establish a signing identity: 'security import' likely failed" >&2
    echo "(keychain locked, or OpenSSL p12 export rejected). The app stays ad-hoc" >&2
    echo "signed — unlock your login keychain and re-run ./sign_mac.sh." >&2
    exit 1
fi

echo "Signing $APP with $IDENTITY ($HASH)..."
codesign --force --deep --sign "$HASH" "$APP"
echo "Verifying signature:"
codesign -dvv "$APP" 2>&1 | grep -iE "Authority|Identifier|Signature" || true
echo ""
echo "Done. The signature is now stable across rebuilds."
echo "First time after switching off ad-hoc: REMOVE any stale 'Human Typer' rows"
echo "from System Settings > Privacy > Accessibility (and Input Monitoring), then"
echo "re-grant once. From then on the grant persists across rebuilds & updates."
