// One-off marketing broadcast: emails active buyers who are NOT on an AI plan
// yet, inviting them to the AI plans. Segmentation, opt-out exclusion, and the
// send all run here so the Supabase/Resend keys stay in Vercel.
//
// Gated on BROADCAST_TOKEN (Bearer or ?token=). Three modes:
//   ?mode=count            -> dry run: audience size + a masked sample (no send)
//   ?mode=preview (POST)   -> send one copy of the email to {to} (owner preview,
//                             no DB writes, does not touch the audience/log)
//   ?mode=send  (POST)     -> send up to `batch` (default 20) and mark them sent;
//                             idempotent (a per-campaign log skips anyone already
//                             mailed), so call repeatedly to drain the list.
//
// Vercel env: BROADCAST_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   RESEND_API_KEY, ADMIN_PASSWORD (for the unsubscribe HMAC). Optional MAIL_FROM.

const crypto = require("crypto");

const CAMPAIGN = "ai-upsell-2026-07";
const SITE = "https://humantyper.rufaiahmed.com";
const SENDER = () => process.env.MAIL_FROM || "Human Typer <keys@updates.rufaiahmed.com>";
const LEGACY_SENDER = "Human Typer <keys@updates.humantyper.online>";  // fallback if the .com isn't verified in Resend
const SUBJECT = "Add AI rewriting to Human Typer";

const BASE = () => process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const SB_HEADERS = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
});

async function rpc(fn, args) {
  const r = await fetch(`${BASE()}/rpc/${fn}`, {
    method: "POST",
    headers: SB_HEADERS(),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`rpc ${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Claim an email for this campaign. Returns true if WE claimed it (safe to send),
// false if it was already claimed (skip, so a re-run never double-sends).
async function claim(email) {
  const r = await fetch(`${BASE()}/campaign_sends`, {
    method: "POST",
    headers: { ...SB_HEADERS(), Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ email, campaign: CAMPAIGN }),
  });
  if (!r.ok) throw new Error(`claim: ${r.status} ${await r.text()}`);
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function unclaim(email) {
  await fetch(
    `${BASE()}/campaign_sends?email=eq.${encodeURIComponent(email)}&campaign=eq.${encodeURIComponent(CAMPAIGN)}`,
    { method: "DELETE", headers: SB_HEADERS() },
  ).catch(() => {});
}

function unsubUrl(email) {
  const t = crypto
    .createHmac("sha256", "ht-unsub:" + (process.env.ADMIN_PASSWORD || ""))
    .update(email)
    .digest("hex");
  return `${SITE}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;
}

function textBody(unsub) {
  return [
    "You already use Human Typer to type like a human. Now it can write like one too.",
    "",
    "The AI plans switch on one-click Rephrase: paste any text and it rewrites it to read natural and human, then types it out. Use the built-in model for free, or plug in your own Claude or Gemini key.",
    "",
    "AI Monthly - 5,000 naira / month",
    "AI Lifetime - 15,000 naira once",
    "",
    `Get AI: ${SITE}/#pricing`,
    "",
    "Already have a key? You keep it. The AI plan just unlocks the Rephrase button.",
    "",
    "Rufai, Human Typer",
    "",
    `Unsubscribe: ${unsub}`,
  ].join("\n");
}

function htmlBody(unsub) {
  return `<div style="font:16px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c2122;max-width:520px;margin:0 auto;padding:8px 4px">
  <p>You already use Human Typer to type like a human. Now it can write like one too.</p>
  <p>The AI plans switch on one-click <strong>Rephrase</strong>: paste any text and it rewrites it to read natural and human, then types it out. Use the built-in model for free, or plug in your own Claude or Gemini key.</p>
  <p style="margin:20px 0">
    <span style="display:inline-block;margin-right:18px">AI Monthly &mdash; <strong>&#8358;5,000</strong>/month</span>
    <span style="display:inline-block">AI Lifetime &mdash; <strong>&#8358;15,000</strong> once</span>
  </p>
  <p style="margin:24px 0"><a href="${SITE}/#pricing" style="background:#34c07d;color:#0a0c0d;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:8px;display:inline-block">Get AI</a></p>
  <p>Already have a key? You keep it. The AI plan just unlocks the Rephrase button.</p>
  <p style="margin-top:22px">Rufai, Human Typer</p>
  <p style="color:#8a9199;font-size:13px;margin-top:26px;border-top:1px solid #e6e8ea;padding-top:14px">
    You're getting this because you bought Human Typer. Licence and purchase emails are unaffected.<br>
    <a href="${unsub}" style="color:#8a9199">Unsubscribe</a>
  </p>
</div>`;
}

// One POST to Resend from a given sender. Returns {status, error}; status 0 =
// network error / timeout.
async function postResend(from, email, unsub) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: email,
        subject: SUBJECT,
        html: htmlBody(unsub),
        text: textBody(unsub),
        headers: {
          "List-Unsubscribe": `<${unsub}>, <mailto:unsubscribe@rufaiahmed.com?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });
    if (r.status >= 200 && r.status < 300) return { status: r.status };
    let error = "";
    try { error = (await r.text()).slice(0, 300); } catch {}
    return { status: r.status, error };
  } catch (e) {
    return { status: 0, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Send from the .com sender, falling back to the verified .online if the .com is
// not verified in Resend (same discipline as claim.js). Returns {status, error};
// 2xx = delivered to Resend; 429 = definitely not sent (retry); else no-retry.
async function sendOne(email) {
  const unsub = unsubUrl(email);
  let r = await postResend(SENDER(), email, unsub);
  if ((r.status < 200 || r.status >= 300) && SENDER() !== LEGACY_SENDER) {
    r = await postResend(LEGACY_SENDER, email, unsub);
  }
  return r;
}

const mask = (e) => {
  const [u, d] = String(e).split("@");
  return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d || ""}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authed(req) {
  const want = process.env.BROADCAST_TOKEN || "";
  if (!want) return false;
  const url = new URL(req.url, "http://x");
  const got =
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("token") || "";
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (!process.env.BROADCAST_TOKEN) {
    res.status(503).json({ ok: false, error: "Broadcast disabled (set BROADCAST_TOKEN)." });
    return;
  }
  if (!authed(req)) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  // ADMIN_PASSWORD required: the unsubscribe HMAC is keyed on it, and an empty
  // one would degrade the secret to a public constant (forgeable opt-outs).
  for (const v of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "ADMIN_PASSWORD"]) {
    if (!process.env[v]) {
      res.status(500).json({ ok: false, error: `Not configured: ${v}` });
      return;
    }
  }

  const url = new URL(req.url, "http://x");
  const mode = url.searchParams.get("mode") || "count";

  try {
    if (mode === "count") {
      const total = await rpc("marketing_audience_count", { p_campaign: CAMPAIGN });
      const sample = await rpc("marketing_audience", { p_campaign: CAMPAIGN, p_limit: 5 });
      res.status(200).json({
        ok: true,
        campaign: CAMPAIGN,
        remaining: Number(total) || 0,
        sample: (sample || []).map(mask),
      });
      return;
    }

    if (mode === "send") {
      if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "Use POST to send." });
        return;
      }
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
      body = body || {};
      if (body.confirm !== "SEND") {
        res.status(400).json({ ok: false, error: 'Refusing to send without {"confirm":"SEND"}.' });
        return;
      }
      // Small batches + a slow throttle keep us under Resend's ~2 req/s default
      // and the function's time limit; call repeatedly to drain the list.
      const batch = Math.min(Math.max(parseInt(body.batch, 10) || 20, 1), 40);
      const throttle = Math.min(Math.max(parseInt(body.throttleMs, 10) || 600, 300), 5000);
      const emails = await rpc("marketing_audience", { p_campaign: CAMPAIGN, p_limit: batch });

      let sent = 0, failed = 0, skipped = 0, lastError = "";
      for (const email of emails || []) {
        let mine = false;
        try {
          mine = await claim(email);
        } catch {
          failed++;
          continue;
        }
        if (!mine) { skipped++; continue; }
        const { status, error } = await sendOne(email);
        if (status >= 200 && status < 300) {
          sent++;
        } else {
          failed++;
          lastError = `${status}: ${error || ""}`.slice(0, 300);
          // A send that didn't go out must NOT stay marked sent. 429 (rate limit)
          // and 4xx (rejected) definitely didn't send -> free them to retry/fix.
          // Only a timeout / 5xx (status 0 or >=500, maybe already accepted) keeps
          // the claim, to avoid a duplicate to a customer.
          if (status === 429 || (status >= 400 && status < 500)) await unclaim(email);
        }
        await sleep(throttle);
      }

      const remaining = Number(await rpc("marketing_audience_count", { p_campaign: CAMPAIGN })) || 0;
      res.status(200).json({ ok: true, campaign: CAMPAIGN, requested: (emails || []).length, sent, failed, skipped, remaining, lastError });
      return;
    }

    if (mode === "preview") {
      if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Use POST." }); return; }
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { body = {}; } }
      const to = String((body && body.to) || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        res.status(400).json({ ok: false, error: "Provide a valid { to } address." });
        return;
      }
      const { status, error } = await sendOne(to);  // no DB writes: a preview, not a campaign recipient
      if (status >= 200 && status < 300) res.status(200).json({ ok: true, preview: to });
      else res.status(502).json({ ok: false, error: `Resend ${status}: ${error || ""}` });
      return;
    }

    if (mode === "reset") {
      if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Use POST." }); return; }
      const r = await fetch(
        `${BASE()}/campaign_sends?campaign=eq.${encodeURIComponent(CAMPAIGN)}`,
        { method: "DELETE", headers: { ...SB_HEADERS(), Prefer: "count=exact" } },
      );
      const cleared = parseInt((r.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
      res.status(r.ok ? 200 : 502).json({ ok: r.ok, campaign: CAMPAIGN, cleared });
      return;
    }

    res.status(400).json({ ok: false, error: "Unknown mode. Use count, preview, send, or reset." });
  } catch (err) {
    console.error("broadcast error:", err && err.message ? err.message : err);
    res.status(502).json({ ok: false, error: "Broadcast failed. Check the server logs." });
  }
};

module.exports.config = { maxDuration: 60 };  // batched send can run longer than the 10s default
