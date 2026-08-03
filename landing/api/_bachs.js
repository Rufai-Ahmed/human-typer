// Bachs client + the USD price table, for buyers paying in crypto (or a USD
// card) instead of naira. Vercel does not expose underscore-prefixed files as
// endpoints, so this is require()-only shared code for checkout.js and claim.js.
//
// Money in the Bachs API is a decimal string at the currency's precision
// ("19.00"), never minor units — but we keep US cents internally so grading
// stays integer-exact, exactly like the kobo tiers on the naira side.
//
// Env: BACHS_SECRET_KEY   sk_live_… (production) or sk_sandbox_… (sandbox).
//        The prefix picks the deployment, so going live is a key swap.
// Optional: BACHS_METHODS (default "crypto,card"), SITE_URL, and any of the
//           USD_*_CENTS price overrides below.

const SANDBOX = "https://sandbox-api.bachs.io";
const PRODUCTION = "https://api.bachs.io";

const configured = () => Boolean(process.env.BACHS_SECRET_KEY);

const base = () =>
  /^sk_sandbox_/.test(process.env.BACHS_SECRET_KEY || "") ? SANDBOX : PRODUCTION;

async function bachs(path, opts = {}) {
  const r = await fetch(`${base()}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.BACHS_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body && (body.detail || body.error_code)) || `HTTP ${r.status}`;
    const err = new Error(`bachs ${path}: ${msg}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

const cents = (name, fallback) =>
  parseInt(process.env[name] || String(fallback), 10);

// Per-seat prices in US cents. These are their own sticker prices, NOT an FX
// conversion of the naira ones: naira stays the local price, this is what the
// rest of the world pays. Override any single-seat price in Vercel env.
function usdTables() {
  return {
    ai_lifetime: { 1: cents("USD_AI_LIFETIME_CENTS", 1900), 5: 1600, 10: 1400, 25: 1200 },
    lifetime: { 1: cents("USD_LIFETIME_CENTS", 1200), 5: 1000, 10: 900, 25: 800 },
    ai_monthly: { 1: cents("USD_AI_MONTHLY_CENTS", 700) },
    monthly: { 1: cents("USD_MONTHLY_CENTS", 300) },
  };
}

// Total US cents for a plan + seat count, or 0 when that combination is not sold.
function usdCents(plan, seats) {
  const perSeat = (usdTables()[plan] || {})[seats];
  return perSeat > 0 ? perSeat * seats : 0;
}

// Every sellable USD total, highest first: the tier table claim.js grades a
// verified payment against, mirroring the kobo tiers used for naira.
function usdTiers() {
  const t = usdTables();
  const tiers = [];
  for (const plan of Object.keys(t)) {
    for (const seats of Object.keys(t[plan])) {
      tiers.push({ plan, seats: Number(seats), minor: t[plan][seats] * Number(seats) });
    }
  }
  return tiers.sort((a, b) => b.minor - a.minor);
}

// Floor grading is only correct while every tier total is strictly distinct and
// descending; a bad env price could otherwise collide with a pack total and
// mis-grade a payment into the wrong plan.
function strictlyDescending(tiers) {
  for (let i = 1; i < tiers.length; i++) {
    if (!(tiers[i].minor < tiers[i - 1].minor)) return false;
  }
  return true;
}

// "19.00" — what the API wants for an amount.
const decimal = (minor) => (Math.round(Number(minor) || 0) / 100).toFixed(2);

// Only USD-priced rails. bank_transfer / mobile_money would convert the USD
// sticker into the buyer's local currency at the live FX rate, which for a
// Nigerian buyer means paying the dollar price instead of the (cheaper) naira
// one on the same page.
const methods = () =>
  (process.env.BACHS_METHODS || "crypto,card")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

module.exports = {
  bachs,
  configured,
  usdCents,
  usdTiers,
  strictlyDescending,
  decimal,
  methods,
};
