// Owner admin API for the /admin.html dashboard.
//
// Auth: every request carries the ADMIN_PASSWORD in the x-admin-key header,
// compared in constant time. Set ADMIN_PASSWORD in Vercel env; without it the
// endpoint refuses everything. The Supabase SERVICE key never leaves here.
//
// POST { action, ...args } -> JSON. Actions:
//   stats                 counts + rough revenue
//   licenses  {q, filter} search/list licenses (max 100)
//   payments              recent monthly-payment ledger
//   revoke    {key}       status='revoked' (kills next online check)
//   restore   {key}       status='active'
//   unbind    {key}       device_id=null (move buyer to a new machine)
//   extend    {key, days} push a monthly key's expiry (stacks like a renewal)
//   resend    {key}       re-email the key to its stored buyer email
//   addkeys   {keys}      bulk-insert fresh pool keys (duplicates ignored)

const crypto = require("crypto");

const same = (x, y) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(x).digest(),
    crypto.createHash("sha256").update(y).digest(),
  );

function passwordOk(given) {
  const want = process.env.ADMIN_PASSWORD || "";
  return Boolean(want && given && same(String(given), want));
}

// Login exchanges the password for a short-lived HMAC token, so the browser
// stores something that expires and dies with any password rotation instead
// of the credential itself.
const tokenSecret = () =>
  crypto.createHash("sha256")
    .update("ht-admin-token:" + (process.env.ADMIN_PASSWORD || ""))
    .digest();

function makeToken(hours = 8) {
  const exp = Date.now() + hours * 3600000;
  const sig = crypto.createHmac("sha256", tokenSecret())
    .update(String(exp)).digest("base64url");
  return { token: `${exp}.${sig}`, exp };
}

function tokenOk(tok) {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,})$/.exec(String(tok || ""));
  if (!m) return false;
  if (Number(m[1]) < Date.now()) return false;
  const want = crypto.createHmac("sha256", tokenSecret())
    .update(m[1]).digest("base64url");
  return same(m[2], want);
}

// Best-effort brute-force damper (per warm instance): delay every failure and
// soft-lock an IP after repeated ones. A long random ADMIN_PASSWORD is still
// the real defense.
const fails = new Map(); // ip -> { n, t }
const ipOf = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockedOut(ip) {
  const f = fails.get(ip);
  return Boolean(f && f.n >= 20 && Date.now() - f.t < 600000);
}
function noteFailure(ip) {
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  f.n += 1;
  fails.set(ip, f);
}

// Errors safe to show the admin; everything else returns a generic message.
const oops = (m) => Object.assign(new Error(m), { expose: true });

const BASE = () => process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const HEADERS = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
});

async function pg(path, opts = {}) {
  const r = await fetch(`${BASE()}${path}`, {
    ...opts,
    headers: { ...HEADERS(), ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return { body: text ? JSON.parse(text) : null, headers: r.headers };
}

// Row count without fetching rows (content-range: "0-24/123").
async function count(table, filter) {
  const q = filter ? `&${filter}` : "";
  const { headers } = await pg(`/${table}?select=key${q}&limit=1`, {
    headers: { Prefer: "count=exact" },
  });
  const range = headers.get("content-range") || "/0";
  return parseInt(range.split("/")[1], 10) || 0;
}

async function sendEmail(to, subject, html) {
  const from = process.env.MAIL_FROM || "Human Typer <keys@updates.rufaiahmed.com>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!r.ok) throw new Error(`resend failed: ${r.status} ${await r.text()}`);
}

const keyBlock = (k) => `
  <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f4f8;
            border:1px solid #e2e2ea;border-radius:10px;padding:14px 16px;text-align:center;
            font-family:'JetBrains Mono',monospace;margin:10px 0">${k}</p>`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body || "{}");
  } catch {
    body = {};
  }
  body = body || {};
  const action = String(body.action || "");
  const ip = ipOf(req);

  if (lockedOut(ip)) {
    res.status(429).json({ ok: false, error: "Too many attempts; wait 10 minutes" });
    return;
  }

  if (action === "login") {
    if (!passwordOk(body.password)) {
      noteFailure(ip);
      await sleep(800);
      res.status(401).json({ ok: false, error: "Wrong password" });
      return;
    }
    fails.delete(ip);
    res.status(200).json({ ok: true, ...makeToken() });
    return;
  }

  const cred = String(req.headers["x-admin-key"] || "");
  if (!(tokenOk(cred) || passwordOk(cred))) {
    noteFailure(ip);
    await sleep(800);
    res.status(401).json({ ok: false, error: "Session expired; unlock again" });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: "Server not configured" });
    return;
  }
  const key = String(body.key || "").trim();
  const now = () => new Date().toISOString();

  try {
    if (action === "stats") {
      const soon = new Date(Date.now() + 7 * 86400000).toISOString();
      const [pool, sold, lifetimeSold, monthlyActive, monthlyExpiring, revoked, activated, monthlyPayments] =
        await Promise.all([
          count("licenses", "sold=eq.false&status=eq.active"),
          count("licenses", "sold=eq.true"),
          count("licenses", "sold=eq.true&plan=eq.lifetime"),
          count("licenses", `plan=eq.monthly&status=eq.active&expires_at=gt.${now()}`),
          count("licenses", `plan=eq.monthly&status=eq.active&expires_at=gt.${now()}&expires_at=lt.${soon}`),
          count("licenses", "status=eq.revoked"),
          count("licenses", "device_id=not.is.null"),
          count("license_payments", ""),
        ]);
      res.status(200).json({
        ok: true,
        stats: {
          pool, sold, lifetimeSold, monthlyActive, monthlyExpiring, revoked, activated,
          monthlyPayments,
          // Rough revenue: team packs sell seats below ₦10k, so this is an estimate.
          revenueEstimateNaira: lifetimeSold * 10000 + monthlyPayments * 2000,
        },
      });
      return;
    }

    if (action === "licenses") {
      const raw = String(body.q || "").trim().slice(0, 80);
      const q = raw.replace(/[^A-Za-z0-9@._+\- ]/g, "");
      const filter = String(body.filter || "all");
      let cond = "";
      if (filter === "pool") cond = "&sold=eq.false&status=eq.active";
      else if (filter === "sold") cond = "&sold=eq.true";
      else if (filter === "monthly") cond = "&plan=eq.monthly&sold=eq.true";
      else if (filter === "lifetime") cond = "&plan=eq.lifetime&sold=eq.true";
      else if (filter === "revoked") cond = "&status=eq.revoked";
      const search = q
        ? `&or=(email.ilike.*${encodeURIComponent(q)}*,key.ilike.*${encodeURIComponent(q)}*,payment_ref.ilike.*${encodeURIComponent(q)}*)`
        : "";
      const { body: rows } = await pg(
        `/licenses?select=key,status,sold,email,payment_ref,device_id,plan,expires_at,activated_at,created_at${cond}${search}&order=created_at.desc&limit=100`,
      );
      res.status(200).json({ ok: true, rows: rows || [] });
      return;
    }

    if (action === "payments") {
      const { body: rows } = await pg(
        "/license_payments?select=payment_ref,key,email,days,processed_at&order=processed_at.desc&limit=100",
      );
      res.status(200).json({ ok: true, rows: rows || [] });
      return;
    }

    if (action === "revoke" || action === "restore") {
      if (!key) throw oops("key required");
      const status = action === "revoke" ? "revoked" : "active";
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status }),
      });
      if (!rows || !rows.length) throw oops("key not found");
      res.status(200).json({ ok: true, row: rows[0] });
      return;
    }

    if (action === "unbind") {
      if (!key) throw oops("key required");
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ device_id: null }),
      });
      if (!rows || !rows.length) throw oops("key not found");
      res.status(200).json({ ok: true, row: rows[0] });
      return;
    }

    if (action === "extend") {
      if (!key) throw oops("key required");
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}&limit=1`);
      const row = rows && rows[0];
      if (!row) throw oops("key not found");
      // Never silently mutate a lifetime license into an expiring one.
      if (!(row.sold && row.plan === "monthly"))
        throw oops("extend only applies to sold monthly keys");
      const base = row.expires_at && new Date(row.expires_at) > new Date()
        ? new Date(row.expires_at)
        : new Date();
      const newExp = new Date(base.getTime() + days * 86400000).toISOString();
      const { body: upd } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ expires_at: newExp }),
      });
      res.status(200).json({ ok: true, row: upd && upd[0] });
      return;
    }

    if (action === "resend") {
      if (!key) throw oops("key required");
      if (!process.env.RESEND_API_KEY) throw oops("RESEND_API_KEY missing");
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}&limit=1`);
      const row = rows && rows[0];
      if (!row) throw oops("key not found");
      if (!row.email) throw oops("no buyer email stored on this key");
      const dl = process.env.DOWNLOAD_URL || "https://www.humantyper.online/#download";
      const monthly = row.plan === "monthly";
      await sendEmail(
        row.email,
        monthly ? "Your Human Typer monthly pass" : "Your Human Typer license key",
        `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
          <h2 style="margin:0 0 8px">Your Human Typer ${monthly ? "monthly pass" : "license key"}</h2>
          <p>Here is your key again${monthly && row.expires_at ? ` (active until <strong>${new Date(row.expires_at).toDateString()}</strong>)` : ""}:</p>
          ${keyBlock(row.key)}
          <p>Download: <a href="${dl}">${dl}</a>. Paste the key on the activation screen.</p>
          <p style="color:#666;font-size:13px">Questions? Reply here or contact me@rufaiahmed.com.</p>
        </div>`,
      );
      res.status(200).json({ ok: true, sent_to: row.email });
      return;
    }

    if (action === "addkeys") {
      const tokens = String(body.keys || "")
        .split(/[\s,]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      const keys = [...new Set(tokens.filter((k) => /^[A-Za-z0-9-]{8,64}$/.test(k)))];
      if (!keys.length) throw oops("no valid keys supplied");
      const { body: rows } = await pg(`/licenses`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(keys.map((k) => ({ key: k }))),
      });
      res.status(200).json({
        ok: true,
        supplied: tokens.length,
        invalid: tokens.length - keys.length,
        inserted: (rows || []).length,
        duplicates: keys.length - (rows || []).length,
      });
      return;
    }

    res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    if (err && err.expose) {
      res.status(400).json({ ok: false, error: err.message });
      return;
    }
    console.error("admin api error:", err);
    res.status(500).json({ ok: false, error: "Internal error" });
  }
};
