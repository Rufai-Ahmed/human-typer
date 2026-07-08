// TEMPORARY: set up the 30% income split to the owner's OPay account.
// Token-gated; DELETE after the subaccount id is wired into checkout.js.
//   ?token=...                 -> list NG banks matching opay + current subaccounts
//   ?token=...&do=create       -> create the subaccount (idempotent-ish: lists first)
//   ?token=...&do=tx&ref=HT-.. -> verify a tx and show settlement fields (split check)

const TOKEN = "ht-split-4k9d2v7q1z";
const V3 = "https://api.flutterwave.com/v3";

async function v3(path, opts = {}) {
  const r = await fetch(`${V3}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.FLW_V3_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

module.exports = async (req, res) => {
  const url = new URL(req.url || "/", "http://local");
  if (url.searchParams.get("token") !== TOKEN) {
    res.status(404).json({ ok: false });
    return;
  }
  if (!process.env.FLW_V3_SECRET_KEY) {
    res.status(503).json({ ok: false, error: "FLW_V3_SECRET_KEY missing" });
    return;
  }
  const out = {};
  try {
    const doWhat = url.searchParams.get("do") || "";

    if (doWhat === "tx") {
      const ref = url.searchParams.get("ref") || "";
      const v = await v3(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(ref)}`);
      const d = (v.body && v.body.data) || {};
      out.tx = {
        status: d.status, amount: d.amount, charged_amount: d.charged_amount,
        amount_settled: d.amount_settled, app_fee: d.app_fee,
        merchant_fee: d.merchant_fee, currency: d.currency, tx_ref: d.tx_ref,
      };
      res.status(200).json(out);
      return;
    }

    const banks = await v3("/banks/NG");
    out.opay_banks = ((banks.body && banks.body.data) || [])
      .filter((b) => /opay|paycom/i.test(b.name || ""));

    const subs = await v3("/subaccounts");
    out.existing_subaccounts = ((subs.body && subs.body.data) || []).map((s) => ({
      id: s.id, subaccount_id: s.subaccount_id, business_name: s.business_name,
      account_number: s.account_number, bank: s.bank_name || s.account_bank,
      split_type: s.split_type, split_value: s.split_value,
    }));

    if (doWhat === "create") {
      const code = out.opay_banks[0] && out.opay_banks[0].code;
      if (!code) throw new Error("OPay not found in the NG bank list");
      const created = await v3("/subaccounts", {
        method: "POST",
        body: JSON.stringify({
          account_bank: code,
          account_number: "7052072208",
          business_name: "Human Typer Split",
          business_mobile: "07052072208",
          country: "NG",
          split_type: "percentage",
          split_value: 0.3,
        }),
      });
      out.create = created;
    }

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err), out });
  }
};
