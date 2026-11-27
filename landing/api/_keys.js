// License key helpers shared by claim.js (pool auto top-up) and admin.js
// (Generate keys). Vercel does not expose underscore-prefixed files as
// endpoints, so this is require()-only shared code.

const crypto = require("crypto");

// Same format and no-lookalikes alphabet as gen_licenses.py.
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function mintKey() {
  const g = () => Array.from({ length: 5 },
    () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join("");
  return `HT-${g()}-${g()}-${g()}`;
}

// PostgREST filter for the sale pool: unsold, active, not bound to a device and
// never activated. A key that was ever activated was given to someone (an old
// unbind cleared device_id but kept activated_at), so it is never for sale.
const POOL_FILTER = "sold=eq.false&status=eq.active&device_id=is.null&activated_at=is.null";

module.exports = { KEY_ALPHABET, mintKey, POOL_FILTER };
