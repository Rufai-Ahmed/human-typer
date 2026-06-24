// Auto-deliver a license key after a Paystack payment (Supabase-backed).
//
// Triggered two ways (both safe — idempotent per payment reference):
//   1. the browser calls it on payment success with { reference }
//   2. Paystack's webhook POSTs { event, data: { reference } } here
//
// It never trusts the caller about success — it re-verifies the transaction with
// Paystack using the SECRET key, then atomically claims an unsold key from
// Supabase and emails it via Resend.
//
// Vercel env vars (set in the dashboard, never in code):
//   PAYSTACK_SECRET_KEY        sk_live_...
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase -> Project Settings -> API -> service_role; SECRET)
//   RESEND_API_KEY             re_...
// Optional: MAIL_FROM, ADMIN_EMAIL, PRICE_KOBO (default 1000000), DOWNLOAD_URL

const PAYSTACK = "https://api.paystack.co";

async function rpc(fn, args) {
    const base = process.env.SUPABASE_URL.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`supabase rpc ${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
}

async function sendEmail(to, subject, html) {
    const from = process.env.MAIL_FROM || "Human Typer <keys@updates.rufaiahmed.com>";
    const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) throw new Error(`resend failed: ${r.status} ${await r.text()}`);
    return r.json();
}

function keyEmailHtml(key, downloadUrl) {
    return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 8px">Your Human Typer license key</h2>
      <p>Thank you for your purchase! Your lifetime key is below.</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f4f8;
                border:1px solid #e2e2ea;border-radius:10px;padding:14px 16px;text-align:center;
                font-family:'JetBrains Mono',monospace">${key}</p>
      <ol style="line-height:1.7">
        <li>Download the app: <a href="${downloadUrl}">${downloadUrl}</a></li>
        <li>Open it and paste this key on the activation screen (one-time, needs internet).</li>
        <li>Activated for life on that machine. No subscription, ever.</li>
      </ol>
      <p style="color:#666;font-size:13px">Keep this email as your proof of purchase.
         Need help or a new device? Reply here or contact me@rufaiahmed.com.</p>
    </div>`;
}

module.exports = async (req, res) => {
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }
    for (const v of ["PAYSTACK_SECRET_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"]) {
        if (!process.env[v]) { res.status(500).json({ ok: false, error: `Server not configured: ${v}` }); return; }
    }

    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body || "{}"); } catch { body = {}; }
    body = body || {};
    const reference = body.reference || (body.data && body.data.reference);
    if (!reference) { res.status(400).json({ ok: false, error: "Missing payment reference" }); return; }

    const priceKobo = parseInt(process.env.PRICE_KOBO || "1000000", 10);
    const downloadUrl = process.env.DOWNLOAD_URL || "https://humantyper.rufaiahmed.com#download";

    try {
        // Source of truth: verify the transaction directly with Paystack.
        const vr = await fetch(`${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`, {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        });
        const v = await vr.json();
        const tx = v && v.data;
        const paid = v && v.status && tx && tx.status === "success"
            && tx.amount >= priceKobo && (tx.currency || "NGN") === "NGN";
        if (!paid) { res.status(200).json({ ok: false, status: "not_a_successful_payment" }); return; }

        const email = tx.customer && tx.customer.email;
        if (!email) { res.status(200).json({ ok: false, status: "no_email" }); return; }

        // Atomically claim an unsold key (idempotent per reference).
        const claim = await rpc("claim_key", { p_email: email, p_ref: reference });
        if (!claim || !claim.key) {
            try { await sendEmail(process.env.ADMIN_EMAIL || "me@rufaiahmed.com",
                "Human Typer: license key pool is EMPTY",
                `<p>Paid order ${reference} (${email}) could not be fulfilled — no keys left. Add keys + re-seed Supabase, then email manually.</p>`); } catch (_) {}
            res.status(200).json({ ok: false, status: "out_of_keys" });
            return;
        }

        if (claim.new === false) { res.status(200).json({ ok: true, status: "already_processed", email }); return; }

        await sendEmail(email, "Your Human Typer license key", keyEmailHtml(claim.key, downloadUrl));
        res.status(200).json({ ok: true, status: "key_sent", email });
    } catch (err) {
        // Let Paystack retry on transient failures.
        res.status(500).json({ ok: false, error: String((err && err.message) || err) });
    }
};
