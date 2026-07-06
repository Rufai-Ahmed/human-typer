// Auto-deliver license keys after a Paystack payment (Supabase-backed).
// Handles both single (1 seat) and team/volume packs (5 / 10 / 25 seats).
//
// Triggered two ways (both safe and idempotent per payment reference):
//   1. the browser calls it on payment success with { reference }
//   2. Paystack's webhook POSTs { event, data: { reference } } here
//
// It never trusts the caller about success or quantity: it re-verifies the
// transaction with Paystack using the SECRET key, derives the seat count from the
// verified amount, then atomically claims that many unsold keys from Supabase and
// emails them via Resend.
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
  const from =
    process.env.MAIL_FROM || "Human Typer <keys@updates.rufaiahmed.com>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
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
  for (const v of [
    "PAYSTACK_SECRET_KEY",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "RESEND_API_KEY",
  ]) {
    if (!process.env[v]) {
      res.status(500).json({ ok: false, error: `Server not configured: ${v}` });
      return;
    }
  }

  let body = req.body;
  try {
    if (typeof body === "string") body = JSON.parse(body || "{}");
  } catch {
    body = {};
  }
  body = body || {};
  const reference = body.reference || (body.data && body.data.reference);
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
    // Source of truth: verify the transaction directly with Paystack.
    const vr = await fetch(
      `${PAYSTACK}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      },
    );
    const v = await vr.json();
    const tx = v && v.data;
    // What the customer was actually charged, in kobo. When Paystack passes its fee
    // to the customer this comes back inflated (e.g. 203046 for the ₦2,000 plan)
    // while requested_amount keeps the price checkout was initialized with. Grade
    // plans on the SMALLER of the two: that strips fee inflation but can never
    // grant more than what was really paid.
    const paidKobo = Number(tx && tx.amount) || 0;
    const requestedKobo = Number(tx && tx.requested_amount) || 0;
    const amount = requestedKobo > 0 ? Math.min(paidKobo, requestedKobo) : paidKobo;
    const okStatus =
      v &&
      v.status &&
      tx &&
      tx.status === "success" &&
      (tx.currency || "NGN") === "NGN";
    // The PLAN is derived ONLY from Paystack-verified amounts, never from anything
    // the client sent: ₦10,000+ is a lifetime order; ₦2,000 up to there is a monthly
    // pass. Floors, not exact matches, so amount noise cannot orphan a real payment.
    const isLifetime = okStatus && amount >= priceKobo;
    const isMonthly = okStatus && !isLifetime && amount >= monthlyKobo;
    if (!okStatus) {
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
            email: (tx.customer && tx.customer.email) || "unknown",
            amountKobo: paidKobo,
            reference,
            planLine: "No plan matched this amount; issue the key manually",
          }),
        );
      } catch (_) {}
      res.status(200).json({ ok: false, status: "unrecognized_amount" });
      return;
    }

    const email = tx.customer && tx.customer.email;
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
          paymentAlertHtml({ email, amountKobo: paidKobo, reference, planLine }),
        );
      } catch (_) {}
    };

    // ===== Monthly pass: 30 days per ₦2,000, renews by paying again =====
    if (isMonthly) {
      const claim = await rpc("claim_or_renew_monthly", {
        p_email: email,
        p_ref: reference,
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
      p_ref: reference,
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
    res.status(200).json({ ok: true, status: "key_sent", email, plan: "lifetime", count });
  } catch (err) {
    // Let Paystack retry on transient failures.
    res
      .status(500)
      .json({ ok: false, error: String((err && err.message) || err) });
  }
};
