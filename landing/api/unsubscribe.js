// One-click unsubscribe for marketing email. The link carries the email plus an
// HMAC so no one can opt out a random address; a match records the address in
// email_optouts (which the broadcast audience query excludes forever after).
//
// Vercel env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_PASSWORD (the HMAC
// secret is derived from it, so no new env is needed).

const crypto = require("crypto");

function sign(email) {
  return crypto
    .createHmac("sha256", "ht-unsub:" + (process.env.ADMIN_PASSWORD || ""))
    .update(email)
    .digest("hex");
}

function valid(email, token) {
  if (!process.env.ADMIN_PASSWORD) return false;  // never validate against a public constant
  const want = sign(email);
  const a = Buffer.from(String(token || ""));
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function optOut(email) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  await fetch(`${base}/rest/v1/email_optouts`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates",
    },
    body: JSON.stringify({ email }),
  });
}

const page = (msg) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>Human Typer</title>` +
  `<div style="font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:16vh auto;padding:0 24px;color:#1c2122">` +
  `<div style="font-weight:600;margin-bottom:8px">Human Typer</div>${msg}</div>`;

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://x");
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";

  if (!email || !valid(email, token)) {
    res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(page("<p>This unsubscribe link is invalid or expired. Reply to the email and I'll remove you.</p>"));
    return;
  }

  try {
    await optOut(email);
  } catch {
    // Best effort: never show a scary error on an unsubscribe click.
  }

  // One-click (List-Unsubscribe-Post) sends POST and wants a bare 200.
  if (req.method === "POST") {
    res.status(200).end();
    return;
  }
  res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page(`<p>You're unsubscribed. You won't get marketing email from Human Typer again.</p>` +
    `<p style="color:#6b7280;font-size:14px">Licence and purchase emails still work as normal.</p>`));
};
