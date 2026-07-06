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
    const ourRef = `HTPROBE2-${Date.now().toString(36)}`;
    results.our_reference = ourRef;
    const va = await tryIt("va_create", () =>
      flw("/virtual-accounts", {
        method: "POST",
        body: JSON.stringify({
          reference: ourRef,
          customer_id: cust.id,
          amount: 2000,
          currency: "NGN",
          account_type: "dynamic",
          expiry: 600,
          narration: "Human Typer",
          meta: { email: "probe@humantyper.online", plan: "probe" },
        }),
      }));
    results.va_create_full = va || null;
    if (va && va.id) {
      const got = await tryIt("va_get", () => flw(`/virtual-accounts/${va.id}`));
      results.va_get_full = got || null;
    }
    // Learn the charges list envelope shape (expected empty until funded).
    try {
      const cl = await flw(`/charges?reference=${encodeURIComponent(ourRef)}`);
      results.charges_list_raw = cl;
    } catch (e) {
      results.charges_list_raw = { error: String(e.message), status: e.status };
    }
  }

  res.status(200).json(results);
};
