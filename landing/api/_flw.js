// Flutterwave v4 client (OAuth client-credentials + fetch helper).
// Vercel does not expose underscore-prefixed files as endpoints, so this is
// require()-only shared code for checkout.js and claim.js.
//
// Env: FLW_CLIENT_ID, FLW_CLIENT_SECRET (both server-side secrets in v4),
//      FLW_ENV=sandbox to hit the developer sandbox instead of production.

const IDP =
  "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";

const BASE =
  process.env.FLW_ENV === "sandbox"
    ? "https://developersandbox-api.flutterwave.com"
    : "https://f4bexperience.flutterwave.com";

// Tokens live 10 minutes; cache in module scope so warm invocations reuse one.
let cached = { token: null, exp: 0 };

async function token() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const r = await fetch(IDP, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.FLW_CLIENT_ID,
      client_secret: process.env.FLW_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok)
    throw new Error(`flutterwave auth failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  cached = {
    token: d.access_token,
    exp: Date.now() + (Number(d.expires_in) || 600) * 1000,
  };
  return cached.token;
}

async function flw(path, opts = {}) {
  const t = await token();
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      // Required tracing header, 12-255 chars.
      "X-Trace-Id": `humantyper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(opts.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      (body && body.error && (body.error.message || body.error.code)) ||
      `HTTP ${r.status}`;
    const err = new Error(`flutterwave ${path}: ${msg}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

const configured = () =>
  Boolean(process.env.FLW_CLIENT_ID && process.env.FLW_CLIENT_SECRET);

module.exports = { flw, configured };
