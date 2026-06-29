// License activation endpoint — the desktop app calls this once (and re-checks on
// launch). Binds a key to a single device and enforces revocation, via Supabase.
//
// Vercel env vars:
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (SECRET — service_role)
//
// Request:  POST { key, device_id }
// Response: { ok: true }  or  { ok: false, reason: "invalid" | "revoked" | "in_use" }

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

module.exports = async (req, res) => {
    // CORS: the desktop app posts from a local origin / file context.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method" }); return; }

    for (const v of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
        if (!process.env[v]) { res.status(500).json({ ok: false, reason: "server_misconfigured" }); return; }
    }

    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body || "{}"); } catch { body = {}; }
    body = body || {};
    const key = (body.key || "").toString().trim();
    const device = (body.device_id || "").toString().trim();
    if (!key || !device) { res.status(400).json({ ok: false, reason: "missing_fields" }); return; }

    try {
        const result = await rpc("activate_key", { p_key: key, p_device: device });
        // activate_key returns { ok, reason?, plan?, expires_at? }
        res.status(200).json(result && typeof result === "object" ? result : { ok: false, reason: "invalid" });
    } catch (err) {
        res.status(502).json({ ok: false, reason: "upstream_error" });
    }
};
