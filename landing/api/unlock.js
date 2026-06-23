// Server-side download gate (Vercel serverless function, Node runtime).
//
// The password lives ONLY in the DOWNLOAD_PASSWORD env var on the server — it is
// never shipped to the browser. Download links are returned only on a correct
// password, so they don't appear in the page source.
//
// Required Vercel env vars:
//   DOWNLOAD_PASSWORD  the access password you hand to buyers
//   DOWNLOAD_BASE      base URL of your release assets, e.g.
//                      https://github.com/<owner>/<repo>/releases/latest/download
const crypto = require('crypto');

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
    }

    const expected = process.env.DOWNLOAD_PASSWORD;
    if (!expected) {
        res.status(500).json({ ok: false, error: 'Server not configured: set DOWNLOAD_PASSWORD.' });
        return;
    }

    let password = '';
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        password = body.password || '';
    } catch (_) {
        password = '';
    }

    if (!password || !safeEqual(password, expected)) {
        res.status(401).json({ ok: false, error: "That password didn't work. Check it and try again." });
        return;
    }

    const base = (process.env.DOWNLOAD_BASE || 'https://github.com/OWNER/REPO/releases/latest/download')
        .replace(/\/$/, '');

    res.status(200).json({
        ok: true,
        downloads: {
            windows:  `${base}/HumanTyper-Windows.zip`,
            macArm:   `${base}/HumanTyper-macOS-AppleSilicon.zip`,
            macIntel: `${base}/HumanTyper-macOS-Intel.zip`,
        },
    });
};
