// AI rephrase proxy for the OWNER'S free Gemini key.
//
// Only the desktop app's "use the free Gemini" option calls this. BYOK (the
// buyer's own Claude or Gemini key) is called directly from the app and never
// touches this endpoint, so it costs the owner nothing and needs no gate.
//
// Gate: the key must be an ACTIVE, unexpired, AI-entitled license bound to the
// calling device (reuses activate_key, which returns "ai"). Then a per-key daily
// cap (ai_bump) bounds abuse of the shared key. The canonical system prompt is
// applied server-side and a client override is IGNORED here, so no one can turn
// the free key into a general chatbot.
//
// Vercel env: GEMINI_API_KEY (the owner's free key), SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY. Optional: GEMINI_MODEL (default gemini-2.0-flash),
//   AI_DAILY_MAX (default 200), AI_MAX_CHARS (default 8000).

const { SYSTEM_PROMPT } = require("./_prompt");

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
  if (!r.ok) throw new Error(`supabase rpc ${fn}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Only tone presets the system prompt defines; anything else falls back to none.
const STYLES = new Set(["natural", "formal", "casual", "simpler", "shorter", "confident"]);
const styleSuffix = (s) => {
  const v = String(s || "").toLowerCase();
  if (!STYLES.has(v) || v === "natural") return "";
  return v === "confident" ? "\n\nStyle: more confident" : `\n\nStyle: ${v}`;
};

// Try each model until one has free-tier quota / exists. Order: env override,
// then the models with real free-tier RPD on a typical project (3.1 Flash Lite
// = 500/day, then older Flash-Lite fallbacks). A model that is missing (404) or
// out of quota (429) advances to the next; a genuine content error surfaces.
function geminiModels() {
  const primary = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
  const chain = [primary, "gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gemini-2.5-flash"];
  return [...new Set(chain)];
}

async function geminiCall(model, text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 8192 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  const err = (j && j.error && j.error.message) || `Gemini HTTP ${r.status}`;
  if (!r.ok) return { retryable: r.status === 404 || r.status === 429 || r.status === 403, err };
  const cand = j.candidates && j.candidates[0];
  if (cand && cand.finishReason === "MAX_TOKENS") {
    return { fatal: "The rephrase was cut off because the text is long. Try a shorter passage." };
  }
  const parts = cand && cand.content && cand.content.parts;
  return { out: (parts || []).map((p) => p && p.text).filter(Boolean).join("") };
}

async function gemini(text) {
  let lastErr = "Gemini is unavailable right now.";
  for (const model of geminiModels()) {
    const r = await geminiCall(model, text);
    if (r.fatal) throw new Error(r.fatal);
    if (r.out !== undefined) return r.out;
    lastErr = r.err;
    if (!r.retryable) throw new Error(r.err);   // real error, not a quota/model miss
  }
  throw new Error(lastErr + " (no free model had quota; enable billing on the Gemini key to lift this).");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  for (const v of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[v]) {
      res.status(500).json({ ok: false, error: `Server not configured: ${v}` });
      return;
    }
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({
      ok: false,
      error: "The free AI option is not available right now. Use your own Claude or Gemini key in Settings.",
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
  const key = String(body.key || "").trim();
  const device = String(body.device || "").trim();
  const text = typeof body.text === "string" ? body.text : "";
  const maxChars = parseInt(process.env.AI_MAX_CHARS || "8000", 10);

  if (!key || !device) {
    res.status(400).json({ ok: false, error: "Missing license key or device" });
    return;
  }
  if (!text.trim()) {
    res.status(400).json({ ok: false, error: "No text to rephrase" });
    return;
  }
  if (text.length > maxChars) {
    res.status(413).json({ ok: false, error: `Text is too long (max ${maxChars} characters). Rephrase it in smaller pieces.` });
    return;
  }

  try {
    // Entitlement: active, unexpired, AI-enabled, bound to THIS device.
    const lic = await rpc("activate_key", { p_key: key, p_device: device });
    if (!lic || !lic.ok) {
      const reason = (lic && lic.reason) || "invalid";
      res.status(403).json({ ok: false, error: `License check failed: ${reason}`, reason });
      return;
    }
    if (!lic.ai) {
      res.status(403).json({
        ok: false,
        error: "Your plan does not include AI. Upgrade to an AI plan to use the free rephraser.",
        reason: "no_ai",
      });
      return;
    }

    // Per-key daily cap on the shared free key.
    const cap = parseInt(process.env.AI_DAILY_MAX || "200", 10);
    const bump = await rpc("ai_bump", { p_key: key, p_max: cap });
    if (bump && bump.ok === false) {
      res.status(429).json({
        ok: false,
        error: `Daily free-AI limit reached (${cap}). It resets tomorrow, or add your own key in Settings for no limit.`,
        reason: "rate_limited",
      });
      return;
    }

    const out = await gemini(text + styleSuffix(body.style));
    if (!out || !out.trim()) {
      res.status(502).json({ ok: false, error: "The AI returned nothing. Try again." });
      return;
    }
    res.status(200).json({ ok: true, text: out });
  } catch (err) {
    res.status(502).json({ ok: false, error: String((err && err.message) || err) });
  }
};
