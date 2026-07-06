// TEMPORARY diagnostic: discover what production's v4 API actually accepts
// for PWBT (docs and prod disagree). Token-gated; returns only error strings
// and ids, never credentials. DELETE after the checkout flow is settled.

const { flw, configured } = require("./_flw");

const TOKEN = "ht-diag-9f3k2m8q7x";

module.exports = async (req, res) => {
  const url = new URL(req.url || "/", "http://local");
  if (url.searchParams.get("token") !== TOKEN) {
    res.status(404).json({ ok: false });
    return;
  }
  if (!configured()) {
    res.status(503).json({ ok: false, error: "FLW env missing" });
    return;
  }

  const results = {};
  const tryIt = async (name, fn) => {
    try {
      const r = await fn();
      const d = r && r.data;
      results[name] = {
        ok: true,
        id: (d && d.id) || null,
        keys: d ? Object.keys(d).slice(0, 12) : [],
      };
      return d;
    } catch (e) {
      results[name] = {
        ok: false,
        status: e.status || null,
        error: String(e.message || e).slice(0, 300),
        detail: (e.body && e.body.error) || null,
      };
      return null;
    }
  };

  const pm = (payload) =>
    flw("/payment-methods", { method: "POST", body: JSON.stringify(payload) });

  await tryIt("pm_bank_transfer", () =>
    pm({ type: "bank_transfer", bank_transfer: { account_type: "dynamic" } }));
  await tryIt("pm_pwbt", () => pm({ type: "pwbt" }));
  await tryIt("pm_virtual_account", () => pm({ type: "virtual_account" }));
  await tryIt("pm_bogus", () => pm({ type: "zzz_bogus" }));
  await tryIt("pm_ussd", () => pm({ type: "ussd", ussd: { account_bank: "058" } }));

  // The PWBT guide's own route: customers + virtual-accounts.
  const cust = await tryIt("customer", async () => {
    try {
      return await flw("/customers", {
        method: "POST",
        body: JSON.stringify({ email: "probe@humantyper.online" }),
      });
    } catch (e) {
      const f = await flw("/customers?email=probe%40humantyper.online");
      const d = f && f.data;
      const arr = Array.isArray(d) ? d : (d && (d.customers || d.items)) || [];
      if (!arr[0]) throw e;
      return { data: arr[0] };
    }
  });
  if (cust && cust.id) {
    await tryIt("virtual_account", () =>
      flw("/virtual-accounts", {
        method: "POST",
        body: JSON.stringify({
          reference: `HTPROBE-${Date.now().toString(36)}`,
          customer_id: cust.id,
          amount: 2000,
          currency: "NGN",
          account_type: "dynamic",
          expiry: 600,
          narration: "Human Typer",
        }),
      }));
  }

  res.status(200).json(results);
};
