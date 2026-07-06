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
  if (!configured()) {
    res.status(503).json({
      ok: false,
      error: "Payments are not configured yet (FLW_CLIENT_ID / FLW_CLIENT_SECRET missing)",
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
  const plan = body.plan === "monthly" ? "monthly" : "lifetime";
  const seats = plan === "monthly" ? 1 : Number(body.seats) || 1;
  if (!VALID_SEATS.has(seats)) {
    res.status(400).json({ ok: false, error: "Invalid seat count" });
    return;
  }

  // Same price source claim.js uses (kobo envs), expressed in naira for v4.
  const priceKobo = parseInt(process.env.PRICE_KOBO || "1000000", 10);
  const monthlyKobo = parseInt(process.env.MONTHLY_KOBO || "200000", 10);
  const PER_SEAT_NAIRA = {
    1: priceKobo / 100, // ₦10,000 single
    5: 8000,
    10: 7000,
    25: 6000,
  };
  const amount =
    plan === "monthly" ? monthlyKobo / 100 : PER_SEAT_NAIRA[seats] * seats;

  // ^[a-zA-Z0-9-]+$, 6-42 chars, unique across all transactions.
  const reference = `HT-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  try {
    const charge = await flw("/orchestration/direct-charges", {
      method: "POST",
      headers: { "X-Idempotency-Key": reference },
      body: JSON.stringify({
        amount,
        currency: "NGN",
        reference,
        redirect_url: "https://www.humantyper.online/",
        payment_method: {
          type: "bank_transfer",
          bank_transfer: {
            account_type: "dynamic",
            account_expires_in: 3600, // seconds: buyer has an hour to transfer
            account_display_name: "Human Typer",
          },
        },
        customer: { email },
        // claim.js falls back to meta.email when the retrieved charge only
        // carries a customer id; plan/seats ride along for the owner alert.
        meta: { email, plan, seats: String(seats) },
      }),
    });

    const d = (charge && charge.data) || {};
    const na = d.next_action || {};
    const bank =
      (na.type === "requires_bank_transfer" && na.requires_bank_transfer) ||
      na.payment_instruction ||
      {};
    if (!bank.account_number) {
      res.status(502).json({
        ok: false,
        error: "Flutterwave did not return transfer details; try again shortly",
      });
      return;
    }
    res.status(200).json({
      ok: true,
      reference,
      charge_id: d.id || "",
      // Display exactly what Flutterwave says to send (it can differ from our
      // sticker price when fees are passed to the customer).
      amount: Number(d.amount) || amount,
      currency: d.currency || "NGN",
      account_number: bank.account_number,
      bank_name: bank.account_bank_name || "",
      expires_at: bank.account_expiration_datetime || "",
      note: bank.note || "",
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: String((err && err.message) || err),
    });
  }
};
