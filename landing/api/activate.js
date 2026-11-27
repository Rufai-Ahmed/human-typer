// License activation endpoint — the desktop app calls this once (and re-checks on
// launch). Binds a key to a single device and enforces revocation, via Supabase.
//
// Vercel env vars:
//   SUPABASE_URL               https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  (SECRET — service_role)
//
// Request:  POST { key, device_id }
// Response: { ok: true }  or  { ok: false, reason: "invalid" | "revoked" | "in_use" | "expired" }
//           or a bare null when the server itself cannot answer (see serverTrouble)

async function rpc(fn, args, opts = {}) {
    const base = process.env.SUPABASE_URL.replace(/\/$/, "");
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const r = await fetch(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: opts.signal,
    });
    if (!r.ok) throw new Error(`supabase rpc ${fn} failed: ${r.status} ${await r.text()}`);
    return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Up to 3 attempts inside one 8s budget, so a brief Supabase hiccup does not
// reach the app and the answer always beats the platform's 10s limit (a 504
// from that limit reads as an invalid key in released app builds). A slow but
// working database gets up to 4s per attempt.
async function activateWithRetry(args) {
    const deadline = Date.now() + 8000;
    const waits = [250, 600];
    for (let i = 0; ; i++) {
        const left = deadline - Date.now();
        try {
            return await rpc("activate_key", args, { signal: AbortSignal.timeout(Math.min(4000, left)) });
        } catch (err) {
            if (i >= waits.length || deadline - Date.now() < waits[i] + 1000) throw err;
            await sleep(waits[i]);
        }
    }
}

// Every released app build treats any JSON error answer as an invalid key and
// deletes the saved activation on launch. A null body makes those builds take
// their "could not reach the server" path, which keeps the user activated.
function serverTrouble(res, cause) {
    console.error("activate: server trouble:", cause);
    res.setHeader("Content-Type", "application/json");
    res.status(200).send("null");
}

module.exports = async (req, res) => {
    // CORS: the desktop app posts from a local origin / file context.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, reason: "method" }); return; }

    for (const v of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
        if (!process.env[v]) { serverTrouble(res, `missing env ${v}`); return; }
    }

    let body = req.body;
    try { if (typeof body === "string") body = JSON.parse(body || "{}"); } catch { body = {}; }
    body = body || {};
    const key = (body.key || "").toString().trim();
    const device = (body.device_id || "").toString().trim();
    if (!key || !device) { res.status(400).json({ ok: false, reason: "missing_fields" }); return; }

    let result;
    try {
        result = await activateWithRetry({ p_key: key, p_device: device });
    } catch (err) {
        serverTrouble(res, err);
        return;
    }
    // activate_key returns { ok, reason?, plan?, expires_at? }
    const out = result && typeof result === "object" ? result : { ok: false, reason: "invalid" };
    if (!out.ok) console.warn("activate refused", out.reason, key.slice(-5));
    res.status(200).json(out);
};
