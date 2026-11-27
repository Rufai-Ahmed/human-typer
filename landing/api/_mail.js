// Key-delivery email shared by claim.js (checkout) and admin.js (resend,
// Generate keys): the Resend sender plus the HTML bodies buyers receive.
// Vercel does not expose underscore-prefixed files as endpoints, so this is
// require()-only shared code.

async function sendEmail(to, subject, html) {
  // rufaiahmed.com is an old .com with sender reputation; humantyper.online is a
  // new .online domain that SpamAssassin (e.g. ImprovMX) scores as spam, so send
  // from the .com by default and only fall back to the .online if it is rejected.
  const primary =
    process.env.MAIL_FROM || "Human Typer <keys@updates.rufaiahmed.com>";
  const legacy = "Human Typer <keys@updates.humantyper.online>";
  // The provider allows 2 sends a second and a claim sends several, so a 429
  // waits a moment and tries again (at most 2 retries per sender).
  const post = async (from) => {
    for (let retry = 0; ; retry++) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to, subject, html }),
      });
      if (r.status !== 429 || retry >= 2) return r;
      await new Promise((done) => setTimeout(done, 1100));
    }
  };
  let r = await post(primary);
  if (!r.ok && primary !== legacy) {
    // New sender domain not verified in Resend yet? Key delivery must not
    // break: fall back to the old verified sender.
    r = await post(legacy);
  }
  if (!r.ok) throw new Error(`resend failed: ${r.status} ${await r.text()}`);
  return r.json();
}

const aiNoteHtml = `
  <p style="background:#eef2ff;border:1px solid #d5ddff;border-radius:10px;padding:12px 14px">
    <strong>AI rephrasing is included.</strong> In the app, open Settings, turn on AI,
    and either use the free Gemini option or paste your own Claude/Gemini key. Then paste
    text, hit Rephrase, and it rewrites it to read human before typing it out.
  </p>`;

function keysEmailHtml(keys, downloadUrl, hasAI) {
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
      ${hasAI ? aiNoteHtml : ""}
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

function monthlyEmailHtml(key, expiresAt, downloadUrl, hasAI) {
  return `
    <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 8px">Your Human Typer ${hasAI ? "AI monthly pass" : "monthly pass"}</h2>
      <p>Thank you! Your pass is active${
        expiresAt ? ` until <strong>${fmtDate(expiresAt)}</strong>` : ""
      }. Your key is below.</p>
      <p style="font-size:20px;font-weight:700;letter-spacing:1px;background:#f4f4f8;
                border:1px solid #e2e2ea;border-radius:10px;padding:14px 16px;text-align:center;
                font-family:'JetBrains Mono',monospace;margin:10px 0">${key}</p>
      ${hasAI ? aiNoteHtml : ""}
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

module.exports = { sendEmail, keysEmailHtml, monthlyEmailHtml, fmtDate };
