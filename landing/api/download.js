// Stable download URL: 302s to the right asset of the newest GitHub Release.
// The landing page (and emails, ads, socials) can link /api/download?os=windows
// forever — asset renames or release timing can never leave a dead link.

module.exports = async (req, res) => {
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    const os = String((req.query && req.query.os) || "").toLowerCase() === "mac" ? "mac" : "windows";
    const repo = process.env.RELEASES_REPO || "Rufai-Ahmed/human-typer";
    const base = `https://github.com/${repo}/releases/latest/download`;
    const fallback = os === "mac" ? `${base}/HumanTyper-macOS.zip` : `${base}/HumanTyper.exe`;
    const wanted = os === "mac"
        ? ["HumanTyper-macOS.zip"]
        : ["HumanTyper.exe", "HumanTyper-Windows.zip"];

    try {
        const headers = { Accept: "application/vnd.github+json", "User-Agent": "human-typer-updater" };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
        if (r.ok) {
            const rel = await r.json();
            for (const n of wanted) {
                const a = (rel.assets || []).find((x) => x.name === n);
                if (a) {
                    res.setHeader("Location", a.browser_download_url);
                    res.status(302).end();
                    return;
                }
            }
        }
    } catch (e) { /* fall through to the static URL */ }
    res.setHeader("Location", fallback);
    res.status(302).end();
};
