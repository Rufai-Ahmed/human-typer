// Latest-version endpoint for the desktop app's update check.
// Reads the newest GitHub Release of the releases repo and returns the version
// plus per-platform download URLs. CDN-cached so it barely touches GitHub's API.
//
// Optional Vercel env: RELEASES_REPO (default "Rufai-Ahmed/human-typer"),
//                      GITHUB_TOKEN (raises GitHub API rate limit; not required).

module.exports = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    const repo = process.env.RELEASES_REPO || "Rufai-Ahmed/human-typer";
    const base = `https://github.com/${repo}/releases/latest/download`;
    const mac = `${base}/HumanTyper-macOS.zip`;   // one universal build for all Macs
    const downloads = {
        windows: `${base}/HumanTyper.exe`,        // single-file exe since 1.6.6
        mac,
        macArm: mac,    // back-compat: updaters from <=1.3.0 asked for these keys
        macIntel: mac,
    };

    try {
        const headers = { Accept: "application/vnd.github+json", "User-Agent": "human-typer-updater" };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
        if (!r.ok) { res.status(200).json({ version: null, downloads }); return; }
        const rel = await r.json();
        // Resolve from the release's REAL asset list, first name that exists,
        // so renaming an asset (zip -> exe in 1.6.6) never hands an old app's
        // update banner a dead URL.
        const asset = (...names) => {
            for (const n of names) {
                const a = (rel.assets || []).find((x) => x.name === n);
                if (a) return a.browser_download_url;
            }
            return null;
        };
        downloads.windows = asset("HumanTyper.exe", "HumanTyper-Windows.zip") || downloads.windows;
        const macUrl = asset("HumanTyper-macOS.zip") || mac;
        downloads.mac = downloads.macArm = downloads.macIntel = macUrl;
        res.status(200).json({
            version: (rel.tag_name || "").replace(/^v/, ""),
            notes: rel.body || "",
            downloads,
        });
    } catch (e) {
        res.status(200).json({ version: null, downloads });
    }
};
