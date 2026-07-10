// Auto-deliver license keys after a Flutterwave payment (Supabase-backed).
// Handles both single (1 seat) and team/volume packs (5 / 10 / 25 seats).
//
// Triggered two ways (both safe and idempotent per payment reference):
//   1. the browser polls it with { reference } while the buyer's bank
//      transfer settles (see api/checkout.js)
//   2. Flutterwave's charge.completed webhook POSTs { type, data: {...} } here
//
// It never trusts the caller about success or quantity: it re-fetches the
// charge from Flutterwave v4 (OAuth), derives plan and seat count from the
// verified amount, then atomically claims unsold keys from Supabase and emails
// them via Resend. Webhook signatures are NOT relied on for value: a forged
// call can only trigger this server-side re-verification.
//
// Old references from the Paystack era still verify through Paystack when
// PAYSTACK_SECRET_KEY remains set, so past buyers can re-claim keys.
//
// Vercel env vars (set in the dashboard, never in code):
//   FLW_CLIENT_ID, FLW_CLIENT_SECRET   Flutterwave v4 credentials
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (Supabase -> Project Settings -> API -> service_role; SECRET)
//   RESEND_API_KEY             re_...
// Optional: PAYSTACK_SECRET_KEY (legacy re-claims), MAIL_FROM, ADMIN_EMAIL,
//           PRICE_KOBO (default 1000000), MONTHLY_KOBO, DOWNLOAD_URL, FLW_ENV

const PAYSTACK = "https://api.paystack.co";
const crypto = require("crypto");
const { flw, configured: flwConfigured } = require("./_flw");

// Fetch a charge from Flutterwave v4 by our merchant reference (HT-...) or by
// charge id (chg_..., what the webhook carries). Returns the charge object or
// null when nothing matches.
async function fetchFlwCharge(refOrId) {
  if (/^chg_/.test(refOrId)) {
    const r = await flw(`/charges/${encodeURIComponent(refOrId)}`);
    return (r && r.data) || null;
  }
  const r = await flw(`/charges?reference=${encodeURIComponent(refOrId)}`);
  // Be liberal about the list envelope shape.
  const d = r && r.data;
  const arr = Array.isArray(d) ? d : (d && (d.charges || d.items)) || [];
  return arr.find((c) => c && c.reference === refOrId) || arr[0] || null;
}

// Normalize either provider's verdict to one shape claim logic can grade:
// { ok, amountKobo, email, reference } — ok only for a REAL successful NGN
// payment confirmed server-side with the provider.
async function verifyPayment(reference) {
  // Flutterwave v3 (Standard hosted checkout) first — the live path.
  if (process.env.FLW_V3_SECRET_KEY) {
    const vr = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.FLW_V3_SECRET_KEY}` } },
    );
    const v = await vr.json().catch(() => null);
    const tx = v && v.data;
    if (v && v.status === "success" && tx) {
      // v3 amounts are naira. charged_amount can include a customer-borne
      // fee while amount keeps the initialized price: grade on the smaller
      // (the Paystack fee lesson), floors downstream forgive noise.
      const amtN = Number(tx.amount) || 0;
      const chargedN = Number(tx.charged_amount) || 0;
      const naira = chargedN > 0 ? Math.min(amtN, chargedN) : amtN;
      return {
        ok: tx.status === "successful" && (tx.currency || "NGN") === "NGN",
        amountKobo: Math.round(naira * 100),
        email:
          (tx.customer && tx.customer.email) ||
          (tx.meta && tx.meta.email) ||
          null,
        reference: tx.tx_ref || reference,
      };
    }
    // Not found in v3: fall through (v4-era or Paystack-era reference).
  }

  // Flutterwave v4 (bank-transfer fallback era).
  if (flwConfigured()) {
    try {
      const c = await fetchFlwCharge(reference);
      if (c) {
        // The charges schema enum says "succeeded"; the PWBT guide says
        // "successful". Accept either — both mean settled money.
        const ok =
          (c.status === "succeeded" || c.status === "successful") &&
          (c.currency || "NGN") === "NGN";
        // v4 amounts are naira decimals and fees live in a separate array, so
        // amount is the charge amount itself; convert to kobo for grading.
        const amountKobo = Math.round((Number(c.amount) || 0) * 100);
        const email =
          (c.customer && c.customer.email) ||
          (c.meta && (c.meta.email || c.meta.Email)) ||
          (c.billing_details && c.billing_details.email) ||
          null;
        return { ok, amountKobo, email, reference: c.reference || reference };
      }
    } catch (e) {
      // A 404 means "not a Flutterwave charge" (fall through to legacy);
      // anything else is a real failure the caller should see.
      if (!(e && (e.status === 404 || e.status === 400))) throw e;
    }
  }

  // Legacy: Paystack-era references (pre-Flutterwave buyers re-claiming).
  if (process.env.PAYSTACK_SECRET_KEY) {
    const vr = await fetch(
      `${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } },
    );
    const v = await vr.json().catch(() => null);
    const tx = v && v.data;
    if (tx) {
      // Paystack passes its fee to the customer, inflating `amount` while
      // requested_amount keeps the initialized price; grade on the smaller.
      const paidKobo = Number(tx.amount) || 0;
      const requestedKobo = Number(tx.requested_amount) || 0;
      const amountKobo =
        requestedKobo > 0 ? Math.min(paidKobo, requestedKobo) : paidKobo;
      const ok =
        Boolean(v.status) &&
        tx.status === "success" &&
        (tx.currency || "NGN") === "NGN";
      return {
        ok,
        amountKobo,
        email: (tx.customer && tx.customer.email) || null,
        reference,
      };
    }
  }

  return { ok: false, amountKobo: 0, email: null, reference };
}

// --- Key pool auto top-up ---------------------------------------------------
// Same format and no-lookalikes alphabet as gen_licenses.py. After a claim
// consumes keys, if fewer than KEY_POOL_MIN unsold ones remain we mint
// KEY_POOL_BATCH fresh ones straight into Supabase, so the pool never runs
// dry mid-sale. Auto-minted keys exist only in Supabase (see them under the
// admin dashboard's "pool" filter). Never throws: a top-up failure must not
// break the claim that triggered it; the "pool is EMPTY" alert stays as the
// last-resort alarm.
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function mintKey() {
  const g = () => Array.from({ length: 5 },
    () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)]).join("");
  return `HT-${g()}-${g()}-${g()}`;
}

async function maybeTopUpPool() {
  try {
    const min = parseInt(process.env.KEY_POOL_MIN || "10", 10);
    const batch = parseInt(process.env.KEY_POOL_BATCH || "50", 10);
    if (min <= 0 || batch <= 0) return; // KEY_POOL_MIN=0 disables auto top-up
    const base = process.env.SUPABASE_URL.replace(/\/$/, "");
    const headers = {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    const c = await fetch(
      `${base}/rest/v1/licenses?select=key&sold=eq.false&status=eq.active&limit=1`,
      { headers: { ...headers, Prefer: "count=exact" } },
    );
    const left = parseInt((c.headers.get("content-range") || "/0").split("/")[1], 10) || 0;
    if (left >= min) return;
    const keys = Array.from({ length: batch }, mintKey);
    const ins = await fetch(`${base}/rest/v1/licenses`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(keys.map((k) => ({ key: k }))),
    });
    const added = ins.ok ? ((await ins.json()) || []).length : 0;
    try {
      await sendEmail(
        process.env.ADMIN_EMAIL || "me@rufaiahmed.com",
        `Human Typer: key pool auto-topped up (+${added})`,
        `<p>The unsold pool was down to <strong>${left}</strong> key(s), below the
         ${min}-key threshold, so ${added} fresh key(s) were auto-generated and added.
         They live in Supabase only; see the admin dashboard's "pool" filter.</p>`,
      );
    } catch (_) {}
  } catch (_) {}
}

async function rpc(fn, args) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok)
    throw new Error(`supabase rpc ${fn} failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Everyone who gets the "money arrived" alerts. PAYMENT_ALERT_EMAIL (comma-
// separated) adds recipients on top of the built-in owner addresses.
const PAYMENT_ALERT_TO = [...new Set(
  `${process.env.PAYMENT_ALERT_EMAIL || ""},payment@rufaiahmed.com,mailoctavemusic@gmail.com`
    .split(",").map((s) => s.trim()).filter(Boolean),
)];

async function sendEmail(to, subject, html) {
  const primary =
    process.env.MAIL_FROM || "Human Typer <keys@updates.humantyper.online>";
  const legacy = "Human Typer <keys@updates.rufaiahmed.com>";
  const post = (from) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
  let r = await post(primary);
  if (!r.ok && primary !== legacy) {
    // New sender domain not verified in Resend yet? Key delivery must not
    // break: fall back to the old verified sender.
    r = await post(legacy);
  }
  if (!r.ok) throw new Error(`resend failed: ${r.status} ${await r.text()}`);
  return r.json();
}

function keysEmailHtml(keys, downloadUrl) {
  const many = keys.length > 1;
  const keyBlocks = keys
    .map(
      (k) => `
      <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f4f8;
                border:1px solid #e2e2ea;border-radius:10px;padding:14px 16px;text-align:center;
                font-family:'JetBrains Mono',monospace;margin:10px 0">${k}</p>`,
    )
    .join("");
  const teamNote = many
    ? `<p style="background:#eef7f1;border:1px solid #cfe9da;border-radius:10px;padding:12px 14px">
         Each key activates <strong>1 device</strong>. Share one key per teammate: one key, one machine.
       </p>`
    : "";
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 8px">Your Human Typer license ${many ? "keys" : "key"}</h2>
      <p>Thank you for your purchase! ${
        many
          ? "Your " + keys.length + " lifetime keys are below."
          : "Your lifetime key is below."
      }</p>
      ${keyBlocks}
      ${teamNote}
      <ol style="line-height:1.7">
        <li>Download the app: <a href="${downloadUrl}">${downloadUrl}</a></li>
        <li>Open it and paste ${
          many ? "a key" : "this key"
        } on the activation screen (one-time, needs internet).</li>
        <li>Activated for life on that machine. No subscription, ever.</li>
      </ol>
      <p style="color:#666;font-size:13px">Keep this email as your proof of purchase.
         Need help or a new device? Reply here or contact me@rufaiahmed.com.</p>
    </div>`;
}

function nairaFromKobo(kobo) {
  return "NGN " + (Math.round(Number(kobo) || 0) / 100).toLocaleString("en-US");
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(iso || "");
  }
}

function monthlyEmailHtml(key, expiresAt, downloadUrl) {
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 8px">Your Human Typer monthly pass</h2>
      <p>Thank you! Your pass is active${
        expiresAt ? ` until <strong>${fmtDate(expiresAt)}</strong>` : ""
      }. Your key is below.</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f4f8;
                border:1px solid #e2e2ea;border-radius:10px;padding:14px 16px;text-align:center;
                font-family:'JetBrains Mono',monospace;margin:10px 0">${key}</p>
      <ol style="line-height:1.7">
        <li>Download the app: <a href="${downloadUrl}">${downloadUrl}</a></li>
        <li>Open it and paste this key on the activation screen (needs internet).</li>
        <li>It works on one device until your pass ends. To keep going, just pay again
            with this same email and your access extends, no new key needed.</li>
      </ol>
      <p style="color:#666;font-size:13px">Keep this email as your proof of purchase.
         Need help or a new device? Reply here or contact me@rufaiahmed.com.</p>
    </div>`;
}

function paymentAlertHtml({ email, amountKobo, reference, planLine }) {
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 10px">New Human Typer payment</h2>
      <p style="margin:4px 0"><strong>Amount:</strong> ${nairaFromKobo(amountKobo)}</p>
      <p style="margin:4px 0"><strong>Email:</strong> ${email}</p>
      <p style="margin:4px 0"><strong>Plan:</strong> ${planLine}</p>
      <p style="margin:10px 0 0;color:#666;font-size:13px"><strong>Reference:</strong> ${reference}</p>
    </div>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  for (const v of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY"]) {
    if (!process.env[v]) {
      res.status(500).json({ ok: false, error: `Server not configured: ${v}` });
      return;
    }
  }
  if (
    !process.env.FLW_V3_SECRET_KEY &&
    !flwConfigured() &&
    !process.env.PAYSTACK_SECRET_KEY
  ) {
    res.status(500).json({
      ok: false,
      error: "Server not configured: Flutterwave keys missing",
    });
    return;
  }

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body || "{}");
  } catch {
    body = {};
  }
  body = body || {};
  // Browser polls send { reference }. Flutterwave webhooks carry data.tx_ref
  // (v3 Standard) or data.reference / data.id (v4 charge.completed).
  const reference =
    body.reference ||
    (body.data && (body.data.tx_ref || body.data.reference || body.data.id));
  if (!reference) {
    res.status(400).json({ ok: false, error: "Missing payment reference" });
    return;
  }

  const priceKobo = parseInt(process.env.PRICE_KOBO || "1000000", 10);
  const monthlyKobo = parseInt(process.env.MONTHLY_KOBO || "200000", 10); // ₦2,000 = 30 days
  const monthlyDays = parseInt(process.env.MONTHLY_DAYS || "30", 10);
  // Fail loudly on a price misconfig: if the monthly amount were >= the lifetime price,
  // every lifetime payment would silently fulfill as a cheap monthly key (revenue loss).
  if (monthlyKobo >= priceKobo) {
    res.status(500).json({
      ok: false,
      error: "Server misconfigured: MONTHLY_KOBO must be less than PRICE_KOBO",
    });
    return;
  }
  const downloadUrl =
    process.env.DOWNLOAD_URL || "https://humantyper.rufaiahmed.com#download";

  // Volume tiers: total paid (in kobo) -> number of 1-device keys to hand out.
  // The seat count is derived ONLY from the Paystack-verified amount below, never
  // from anything the client sent (anti-fraud). A buyer is granted the largest tier
  // whose total they actually covered, so they can never get more keys than paid for.
  // Keep this in sync with PER_SEAT_KOBO in app.js.
  const TIERS = [
    { seats: 25, totalKobo: 15000000 }, // ₦6,000/seat
    { seats: 10, totalKobo: 7000000 }, // ₦7,000/seat
    { seats: 5, totalKobo: 4000000 }, // ₦8,000/seat
    { seats: 1, totalKobo: priceKobo }, // ₦10,000/seat (single)
  ];
  const seatsForAmount = (amountKobo) => {
    for (const t of TIERS) if (amountKobo >= t.totalKobo) return t.seats;
    return 0;
  };

  try {
    // Source of truth: re-fetch the payment from the provider (Flutterwave v4,
    // falling back to Paystack for legacy references).
    const verified = await verifyPayment(String(reference));
    const paidKobo = verified.amountKobo;
    const amount = paidKobo;
    // The PLAN is derived ONLY from provider-verified amounts, never from anything
    // the client sent: ₦10,000+ is a lifetime order; ₦2,000 up to there is a monthly
    // pass. Floors, not exact matches, so amount noise cannot orphan a real payment.
    const isLifetime = verified.ok && amount >= priceKobo;
    const isMonthly = verified.ok && !isLifetime && amount >= monthlyKobo;
    if (!verified.ok) {
      res.status(200).json({ ok: false, status: "not_a_successful_payment" });
      return;
    }
    if (!isMonthly && !isLifetime) {
      // Verified money arrived but matched no plan: alert the owner to fulfill it
      // manually instead of dropping it like a failed verify.
      try {
        await sendEmail(
          PAYMENT_ALERT_TO,
          `Human Typer payment needs manual review: ${nairaFromKobo(paidKobo)}`,
          paymentAlertHtml({
            email: verified.email || "unknown",
            amountKobo: paidKobo,
            reference: verified.reference,
            planLine: "No plan matched this amount; issue the key manually",
          }),
        );
      } catch (_) {}
      res.status(200).json({ ok: false, status: "unrecognized_amount" });
      return;
    }

    const email = verified.email;
    if (!email) {
      res.status(200).json({ ok: false, status: "no_email" });
      return;
    }

    // Owner alert for any NEW payment (best-effort, once per reference).
    const alertOwner = async (planLine) => {
      try {
        await sendEmail(
          PAYMENT_ALERT_TO,
          `New Human Typer payment: ${nairaFromKobo(paidKobo)} from ${email}`,
          paymentAlertHtml({ email, amountKobo: paidKobo, reference: verified.reference, planLine }),
        );
      } catch (_) {}
    };

    // ===== Monthly pass: 30 days per ₦2,000, renews by paying again =====
    if (isMonthly) {
      const claim = await rpc("claim_or_renew_monthly", {
        p_email: email,
        p_ref: verified.reference,
        p_days: monthlyDays,
      });
      const key = claim && claim.key;
      const expiresAt = claim && claim.expires_at;
      const isNew = !claim || claim.new !== false;

      if (isNew) {
        await alertOwner(
          `Monthly pass (${monthlyDays} days)${
            expiresAt ? `, active until ${fmtDate(expiresAt)}` : ""
          }`,
        );
      }
      if (!key) {
        try {
          await sendEmail(
            process.env.ADMIN_EMAIL || "me@rufaiahmed.com",
            "Human Typer: license key pool is EMPTY",
            `<p>Paid monthly order ${reference} (${email}) could not be fulfilled; no unsold keys left. Add keys + re-seed Supabase, then issue manually.</p>`,
          );
        } catch (_) {}
        res.status(200).json({ ok: false, status: "out_of_keys", email });
        return;
      }
      if (!isNew) {
        res.status(200).json({
          ok: true,
          status: "already_processed",
          email,
          plan: "monthly",
          count: 1,
          expires_at: expiresAt,
        });
        return;
      }
      await sendEmail(
        email,
        "Your Human Typer monthly pass",
        monthlyEmailHtml(key, expiresAt, downloadUrl),
      );
      await maybeTopUpPool();
      res.status(200).json({
        ok: true,
        status: "key_sent",
        email,
        plan: "monthly",
        count: 1,
        expires_at: expiresAt,
      });
      return;
    }

    // ===== Lifetime: one-time single or team/volume packs =====
    // How many keys this payment is owed, from the VERIFIED amount only.
    const qty = seatsForAmount(amount);

    // Atomically claim up to `qty` unsold keys. Idempotent per reference: a repeat
    // call for the same payment returns the SAME keys and never allocates more.
    const claim = await rpc("claim_keys", {
      p_email: email,
      p_ref: verified.reference,
      p_qty: qty,
    });
    const keys = (claim && claim.keys) || [];
    const count = keys.length;

    if (!claim || claim.new !== false) {
      await alertOwner(`Lifetime, ${count} of ${qty} key(s) delivered`);
    }

    if (count === 0) {
      try {
        await sendEmail(
          process.env.ADMIN_EMAIL || "me@rufaiahmed.com",
          "Human Typer: license key pool is EMPTY",
          `<p>Paid order ${reference} (${email}) for ${qty} seat(s) could not be fulfilled; no keys left. Add keys + re-seed Supabase, then email manually.</p>`,
        );
      } catch (_) {}
      res.status(200).json({ ok: false, status: "out_of_keys", email });
      return;
    }

    if (claim.new === false) {
      res
        .status(200)
        .json({ ok: true, status: "already_processed", email, plan: "lifetime", count });
      return;
    }

    // Short pool: fewer keys than paid for. Send what we have and flag a manual top-up.
    if (count < qty) {
      try {
        await sendEmail(
          process.env.ADMIN_EMAIL || "me@rufaiahmed.com",
          "Human Typer: volume order PARTIALLY filled",
          `<p>Paid order ${reference} (${email}) needed ${qty} keys but only ${count} were available. Those ${count} were emailed; add ${qty - count} more key(s), re-seed Supabase, and send the rest manually.</p>`,
        );
      } catch (_) {}
    }

    const subject =
      count > 1
        ? `Your ${count} Human Typer license keys`
        : "Your Human Typer license key";
    await sendEmail(email, subject, keysEmailHtml(keys, downloadUrl));
    await maybeTopUpPool();
    res.status(200).json({ ok: true, status: "key_sent", email, plan: "lifetime", count });
  } catch (err) {
    // 500 lets the provider's webhook retry on transient failures.
    res
      .status(500)
      .json({ ok: false, error: String((err && err.message) || err) });
  }
};
