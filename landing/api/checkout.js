// Start a Flutterwave v4 Pay-With-Bank-Transfer payment.
//
// The browser sends { email, plan: "lifetime"|"monthly", seats } and gets back
// a one-time virtual account (bank + account number + exact amount + expiry).
// The buyer transfers from their banking app; the page polls /api/claim with
// the returned reference until the charge reads "succeeded" and the key ships.
//
// Amounts are computed HERE from the same price table /api/claim grades with;
// nothing the client sends can change what a plan costs. v4 amounts are in
// naira (major units), while claim.js grades in kobo — keep both views in sync
// through the same PRICE_KOBO / MONTHLY_KOBO envs.

const { flw, configured } = require("./_flw");

const VALID_SEATS = new Set([1, 5, 10, 25]);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  if (!configured() && !process.env.FLW_V3_SECRET_KEY) {
    res.status(503).json({
      ok: false,
      error: "Payments are not configured yet (Flutterwave keys missing)",
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

  const email = String(body.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: "A valid email is required" });
    return;
  }
  const PLANS = new Set(["monthly", "ai_monthly", "lifetime", "ai_lifetime"]);
  const plan = PLANS.has(body.plan) ? body.plan : "lifetime";
  // Only the no-AI lifetime plan has team/volume seats; the rest are 1 device.
  const seats = plan === "lifetime" ? Number(body.seats) || 1 : 1;
  if (!VALID_SEATS.has(seats)) {
    res.status(400).json({ ok: false, error: "Invalid seat count" });
    return;
  }

  // Prices in naira (the v3 checkout unit). Team seats apply to "lifetime" only.
  // Keep in sync with the tier table in api/claim.js.
  const priceNaira = parseInt(process.env.PRICE_KOBO || "1000000", 10) / 100;
  const PER_SEAT_NAIRA = { 1: priceNaira, 5: 8000, 10: 7000, 25: 6000 };
  const PLAN_NAIRA = {
    monthly: parseInt(process.env.MONTHLY_KOBO || "200000", 10) / 100, // ₦2,000
    ai_monthly: parseInt(process.env.AI_MONTHLY_KOBO || "500000", 10) / 100, // ₦5,000
    ai_lifetime: parseInt(process.env.AI_LIFETIME_KOBO || "1500000", 10) / 100, // ₦15,000
  };
  const amount =
    plan === "lifetime" ? PER_SEAT_NAIRA[seats] * seats : PLAN_NAIRA[plan];

  // Refuse to create a payment on a broken price config (mirrors claim.js grading
  // order) rather than charge a wrong amount.
  if (
    !(amount > 0) ||
    !(PLAN_NAIRA.monthly < PLAN_NAIRA.ai_monthly &&
      PLAN_NAIRA.ai_monthly < PER_SEAT_NAIRA[1] &&
      PER_SEAT_NAIRA[1] < PLAN_NAIRA.ai_lifetime)
  ) {
    res.status(503).json({ ok: false, error: "Payments are temporarily unavailable." });
    return;
  }

  // ^[a-zA-Z0-9-]+$, 6-42 chars, unique across all transactions.
  const reference = `HT-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  try {
    // Preferred: Flutterwave Standard (v3) hosted checkout — the buyer picks
    // card / transfer / USSD on Flutterwave's page and gets redirected back.
    // Activates as soon as FLW_V3_SECRET_KEY exists in env.
    if (process.env.FLW_V3_SECRET_KEY) {
      const r = await fetch("https://api.flutterwave.com/v3/payments", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.FLW_V3_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tx_ref: reference,
          amount,
          currency: "NGN",
          redirect_url: "https://www.humantyper.online/",
          customer: { email },
          meta: { email, plan, seats: String(seats) },
          customizations: {
            title: "Human Typer",
            logo: "https://www.humantyper.online/icon.png",
          },
          // Income split: this subaccount (owner-configured, defaults to the
          // OPay partner account) takes its dashboard-defined 30% cut of every
          // payment. Set FLW_SPLIT_SUBACCOUNT=off to disable without a deploy.
          subaccounts:
            process.env.FLW_SPLIT_SUBACCOUNT === "off"
              ? undefined
              : [{ id: process.env.FLW_SPLIT_SUBACCOUNT || "RS_A34CBA26455A4B3F565F08416CCAD88F" }],
        }),
      });
      const j = await r.json().catch(() => ({}));
      const link = j && j.data && j.data.link;
      if (!r.ok || !link) {
        res.status(502).json({
          ok: false,
          error: (j && j.message) || `flutterwave v3 payments failed (${r.status})`,
        });
        return;
      }
      res.status(200).json({ ok: true, mode: "hosted", reference, link });
      return;
    }

    // Fallback (no v3 key yet): v4 Pay-With-Bank-Transfer.
    // PWBT on this production account works through the virtual-accounts
    // product (the charges/payment-methods route rejects bank_transfer):
    // create/reuse the customer, then mint a dynamic account carrying OUR
    // reference and meta. Funding settles as a charge under that reference.
    let customerId = null;
    try {
      const cu = await flw("/customers", {
        method: "POST",
        headers: { "X-Idempotency-Key": `${reference}-cus` },
        body: JSON.stringify({ email }),
      });
      customerId = cu && cu.data && cu.data.id;
    } catch (e) {
      // "Customer already exists" (repeat buyer / renewal): look them up,
      // accepting only an exact email match.
      const enc = encodeURIComponent(email);
      const lookup = async (path) => {
        const f = await flw(path).catch(() => null);
        const d = f && f.data;
        const arr = Array.isArray(d) ? d : (d && (d.customers || d.items)) || [];
        const m = arr.find((c) => c && c.email === email);
        return (m && m.id) || null;
      };
      customerId =
        (await lookup(`/customers?email=${enc}`)) ||
        (await lookup(`/customers/search?email=${enc}`));
      if (!customerId) throw e;
    }
    if (!customerId) throw new Error("no customer id returned");

    const va = await flw("/virtual-accounts", {
      method: "POST",
      headers: { "X-Idempotency-Key": reference },
      body: JSON.stringify({
        reference,
        customer_id: customerId,
        amount,
        currency: "NGN",
        account_type: "dynamic",
        expiry: 3600,
        narration: "Human Typer",
        // claim.js falls back to meta.email when the verified payment only
        // carries a customer id; plan/seats ride along for the owner alert.
        meta: { email, plan, seats: String(seats) },
      }),
    });

    const d = (va && va.data) || {};
    if (!d.account_number) {
      res.status(502).json({
        ok: false,
        error: "Flutterwave did not return transfer details; try again shortly",
      });
      return;
    }
    res.status(200).json({
      ok: true,
      reference: d.reference || reference,
      va_id: d.id || "",
      // Display exactly what Flutterwave says to send (it can differ from our
      // sticker price if fees are ever passed to the customer).
      amount: Number(d.amount) || amount,
      currency: d.currency || "NGN",
      account_number: d.account_number,
      bank_name: d.account_bank_name || "",
      expires_at: d.account_expiration_datetime || "",
      note: d.note || "",
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: String((err && err.message) || err),
    });
  }
};
