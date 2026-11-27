// Owner admin API for the /admin.html dashboard.
//
// Auth: every request carries the ADMIN_PASSWORD in the x-admin-key header,
// compared in constant time. Set ADMIN_PASSWORD in Vercel env; without it the
// endpoint refuses everything. The Supabase SERVICE key never leaves here.
//
// POST { action, ...args } -> JSON. Actions:
//   stats                 counts + rough revenue
//   licenses  {q, filter} search/list licenses (max 100); filter "double" lists
//                         monthly sales whose key was activated before the payment
//   payments              recent monthly-payment ledger
//   revoke    {key}       status='revoked' (kills next online check)
//   restore   {key}       status='active'
//   unbind    {key}       device_id=null (move buyer to a new machine); the key
//                         stays sold so it never drops back into the sale pool
//   extend    {key, days} push a monthly key's expiry (stacks like a renewal)
//   resend    {key}       re-email the key to its stored buyer email
//   addkeys   {keys}      bulk-insert fresh pool keys (duplicates ignored)
//   generate  {count, dest, plan, days, email, label, send}
//                         mint keys: dest "pool" adds them to the sale pool;
//                         dest "issue" makes sold keys for one buyer (bank
//                         transfer, replacement, gift) and can email them
//   reserve   {key}       take one pool key out of the sale pool (sold, MANUAL
//                         ref) so the owner can send it to someone safely
//   replace   {key}       someone else holds this buyer's key: move the buyer,
//                         ref and payments to a fresh key and email it to them

const crypto = require("crypto");
const { KEY_ALPHABET, mintKey, POOL_FILTER } = require("./_keys");
const { sendEmail, keysEmailHtml, monthlyEmailHtml } = require("./_mail");

const MONTHLY_PLANS = ["monthly", "ai_monthly"];
const ISSUE_PLANS = ["monthly", "ai_monthly", "lifetime", "ai_lifetime"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // same check as checkout.js

// Payment ref for keys given out by hand: MANUAL-[label-]YYYYMMDD-XXXXXX.
function manualRef(label) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const tail = Array.from({ length: 6 },
    () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join("");
  return `MANUAL-${label ? label + "-" : ""}${day}-${tail}`;
}

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
  if (!r.ok) {
    const text = await r.text();
    throw Object.assign(new Error(`supabase ${path}: ${r.status} ${text}`), { status: r.status, text });
  }
  const text = await r.text();
  return { body: text ? JSON.parse(text) : null, headers: r.headers };
}

// PostgREST answers 404 / PGRST202 for a function that does not exist, which
// here means supabase_keys_migration.sql has not been run yet.
async function rpcCall(fn, args) {
  try {
    const { body } = await pg(`/rpc/${fn}`, { method: "POST", body: JSON.stringify(args || {}) });
    return body;
  } catch (err) {
    if (err && (err.status === 404 || /PGRST202/.test(err.text || ""))) {
      throw oops("run supabase_keys_migration.sql in Supabase first");
    }
    throw err;
  }
}

// Emails keys with the same templates and subjects checkout uses: lifetime-like
// keys in one email, each monthly key in its own (600ms apart, so a batch does
// not trip the mail provider's rate limit). On a failure the error carries how
// many emails went out.
async function emailKeys(to, keys, plan, expiresAt) {
  const dl = process.env.DOWNLOAD_URL || "https://www.humantyper.online/#download";
  const hasAI = plan === "ai_monthly" || plan === "ai_lifetime";
  if (!MONTHLY_PLANS.includes(plan)) {
    const subject =
      keys.length > 1
        ? `Your ${keys.length} Human Typer license keys`
        : hasAI
          ? "Your Human Typer AI Lifetime key"
          : "Your Human Typer license key";
    await sendEmail(to, subject, keysEmailHtml(keys, dl, hasAI));
    return;
  }
  let sent = 0;
  try {
    for (const k of keys) {
      if (sent) await sleep(600);
      await sendEmail(
        to,
        hasAI ? "Your Human Typer AI monthly pass" : "Your Human Typer monthly pass",
        monthlyEmailHtml(k, expiresAt, dl, hasAI),
      );
      sent += 1;
    }
  } catch (err) {
    throw Object.assign(err, { sent, total: keys.length });
  }
}

const sendFailText = (err) =>
  err && err.total > 1
    ? `sent ${err.sent} of ${err.total} emails; copy the keys and send the rest yourself`
    : "could not send the email; copy the key and send it yourself";

// Row count without fetching rows (content-range: "0-24/123").
async function count(table, filter) {
  const q = filter ? `&${filter}` : "";
  const { headers } = await pg(`/${table}?select=key${q}&limit=1`, {
    headers: { Prefer: "count=exact" },
  });
  const range = headers.get("content-range") || "/0";
  return parseInt(range.split("/")[1], 10) || 0;
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
          count("licenses", POOL_FILTER),
          count("licenses", "sold=eq.true"),
          // Real sales only: hand-outs have no ref, keys given out by hand a MANUAL- one.
          count("licenses", "sold=eq.true&plan=eq.lifetime&payment_ref=not.is.null&payment_ref=not.like.MANUAL-*"),
          count("licenses", `plan=in.(monthly,ai_monthly)&status=eq.active&expires_at=gt.${now()}`),
          count("licenses", `plan=in.(monthly,ai_monthly)&status=eq.active&expires_at=gt.${now()}&expires_at=lt.${soon}`),
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
      if (filter === "pool") cond = `&${POOL_FILTER}`;
      else if (filter === "sold") cond = "&sold=eq.true";
      else if (filter === "monthly") cond = "&plan=in.(monthly,ai_monthly)&sold=eq.true";
      else if (filter === "lifetime") cond = "&plan=in.(lifetime,ai_lifetime)&sold=eq.true";
      else if (filter === "revoked") cond = "&status=eq.revoked";
      const search = q
        ? `&or=(email.ilike.*${encodeURIComponent(q)}*,key.ilike.*${encodeURIComponent(q)}*,payment_ref.ilike.*${encodeURIComponent(q)}*)`
        : "";
      const pageSize = 50;
      const page = Math.max(parseInt(body.page, 10) || 0, 0);
      if (filter === "double") {
        const list = await rpcCall("double_sold_keys", {});
        // setof text comes back as plain strings; accept {double_sold_keys: k} too.
        const keys = (Array.isArray(list) ? list : [])
          .map((x) => (x && typeof x === "object" ? x.double_sold_keys : x))
          .filter((k) => /^[A-Za-z0-9-]{1,64}$/.test(String(k || "")))
          .slice(0, 200);
        if (!keys.length) {
          res.status(200).json({ ok: true, rows: [], total: 0, page, pageSize });
          return;
        }
        cond = `&key=in.(${keys.join(",")})`;
      }
      const { body: rows, headers } = await pg(
        `/licenses?select=key,status,sold,email,payment_ref,device_id,plan,expires_at,ai_enabled,activated_at,created_at${cond}${search}&order=created_at.desc&limit=${pageSize}&offset=${page * pageSize}`,
        { headers: { Prefer: "count=exact" } },
      );
      const total = parseInt((headers.get("content-range") || "/0").split("/")[1], 10) || 0;
      res.status(200).json({ ok: true, rows: rows || [], total, page, pageSize });
      return;
    }

    if (action === "payments") {
      const pageSize = 50;
      const page = Math.max(parseInt(body.page, 10) || 0, 0);
      const { body: rows, headers } = await pg(
        `/license_payments?select=payment_ref,key,email,days,processed_at&order=processed_at.desc&limit=${pageSize}&offset=${page * pageSize}`,
        { headers: { Prefer: "count=exact" } },
      );
      const total = parseInt((headers.get("content-range") || "/0").split("/")[1], 10) || 0;
      res.status(200).json({ ok: true, rows: rows || [], total, page, pageSize });
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
      // A key that had a device was handed to someone, so it stays sold.
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ device_id: null, sold: true }),
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
      if (!(row.sold && (row.plan === "monthly" || row.plan === "ai_monthly")))
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
      const monthly = MONTHLY_PLANS.includes(row.plan);
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

    if (action === "setai") {
      if (!key) throw oops("key required");
      // 'on' = force AI, 'off' = force no AI, 'auto' = follow the plan (null).
      const v = String(body.ai || "auto");
      const val = v === "on" ? true : v === "off" ? false : null;
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ ai_enabled: val }),
      });
      if (!rows || !rows.length) throw oops("key not found");
      res.status(200).json({ ok: true, row: rows[0] });
      return;
    }

    if (action === "reserve") {
      if (!key) throw oops("key required");
      // Only matches while the key is still in the pool, so a key checkout
      // already sold (or one someone activated) is never touched.
      const { body: rows } = await pg(`/licenses?key=eq.${encodeURIComponent(key)}&${POOL_FILTER}`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ sold: true, payment_ref: manualRef() }),
      });
      if (!rows || !rows.length) throw oops("that key is not in the sale pool");
      res.status(200).json({ ok: true, row: rows[0] });
      return;
    }

    if (action === "replace") {
      if (!key) throw oops("key required");
      const out = await rpcCall("replace_key", { p_key: key, p_new: mintKey() });
      if (!out || !out.ok) {
        throw oops(out && out.reason === "no_buyer" ? "this key has no buyer to move" : "key not found");
      }
      let emailed = false;
      let email_error;
      if (!process.env.RESEND_API_KEY) {
        email_error = "RESEND_API_KEY missing; copy the key and send it yourself";
      } else {
        try {
          await emailKeys(out.email, [out.key], out.plan, out.expires_at);
          emailed = true;
        } catch (err) {
          console.error("admin replace: email failed:", err);
          email_error = sendFailText(err);
        }
      }
      res.status(200).json({
        ok: true, key: out.key, email: out.email, plan: out.plan, expires_at: out.expires_at,
        old_restored: out.old_restored, emailed, ...(email_error ? { email_error } : {}),
      });
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

    if (action === "generate") {
      const n = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 500);
      const dest = String(body.dest || "");
      if (dest !== "pool" && dest !== "issue") throw oops("pick where the keys go");
      const fresh = new Set();
      while (fresh.size < n) fresh.add(mintKey());
      const insert = (rows) => pg(`/licenses`, {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });

      if (dest === "pool") {
        // The keys stay out of the response: checkout hands pool keys out by
        // itself, and copying one to give away is how a key gets sold twice.
        const { body: rows } = await insert([...fresh].map((k) => ({ key: k })));
        res.status(200).json({ ok: true, dest: "pool", inserted: (rows || []).length });
        return;
      }

      const plan = String(body.plan || "");
      if (!ISSUE_PLANS.includes(plan)) throw oops("pick a plan");
      const monthly = MONTHLY_PLANS.includes(plan);
      const days = Math.min(Math.max(parseInt(body.days, 10) || 30, 1), 365);
      const expires_at = monthly ? new Date(Date.now() + days * 86400000).toISOString() : null;
      const email = String(body.email || "").trim();
      if (email && !EMAIL_RE.test(email)) throw oops("that email does not look right");
      const label = String(body.label || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
      const send = body.send === true;
      if (send && !email) throw oops("enter the buyer's email to send the key");
      if (send && !process.env.RESEND_API_KEY) throw oops("RESEND_API_KEY missing");
      if (send && monthly && n > 10) throw oops("email at most 10 monthly keys at once");

      const payment_ref = manualRef(label);
      const { body: rows } = await insert([...fresh].map((k) => ({
        key: k, sold: true, plan, email: email || null, payment_ref, expires_at,
      })));
      const keys = (rows || []).map((r) => r.key);
      if (!keys.length) throw oops("no keys were created; try again");

      let emailed = false;
      let email_error;
      if (send) {
        try {
          await emailKeys(email, keys, plan, expires_at);
          emailed = true;
        } catch (err) {
          // The keys exist already; hand them back so they are not lost.
          console.error("admin generate: email failed:", err);
          email_error = sendFailText(err);
        }
      }
      res.status(200).json({
        ok: true, dest: "issue", keys, plan, expires_at, email: email || null,
        payment_ref, emailed, ...(email_error ? { email_error } : {}),
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
