# Human Typer — landing page

Static marketing + download page with a **server-side password gate**, built to
deploy on Vercel at `humantypist.rufaiahmed.com`.

```
landing/
  index.html        marketing + gated download UI
  styles.css        styling (on-brand, GPU-light)
  app.js            typing demo + unlock flow
  api/unlock.js     serverless password check (Vercel function)
  icon.png          favicon / social image
```

## How the gate works

1. A visitor enters the access password and the browser POSTs it to `/api/unlock`.
2. The function compares it to the `DOWNLOAD_PASSWORD` env var **on the server**
   (timing-safe). The password is never in the page source.
3. On success the function returns the download URLs and the buttons unlock.

> **Honest limitation:** the release `.zip` files themselves are public URLs, so
> the password controls who sees the links *on your site* — it deters casual
> sharing, but a determined person who already has a link can still use it.
> For true protection (private files + short-lived signed links), move the
> builds to private storage (Cloudflare R2 / S3 / Vercel Blob) and have the
> function mint a signed URL after the password check. Ask and I'll wire that up.

## Deploy to Vercel

1. Push this repo to GitHub (see the repo root).
2. In Vercel: **Add New → Project →** import the repo.
   - **Root Directory:** `landing`
   - **Framework Preset:** Other (it's static + a function — zero config).
3. **Settings → Environment Variables**, add:
   | Name | Value |
   |---|---|
   | `DOWNLOAD_PASSWORD` | the long access password you give buyers |
   | `DOWNLOAD_BASE` | `https://github.com/<owner>/<repo>/releases/latest/download` |
4. Deploy.

## Custom subdomain

1. Vercel project → **Settings → Domains → Add** `humantypist.rufaiahmed.com`.
2. Vercel shows a DNS record (a `CNAME` to `cname.vercel-dns.com`). Add it to
   the DNS for `rufaiahmed.com`. It verifies in a few minutes.

## Download links

The buttons resolve to the assets published by the root repo's
`.github/workflows/build.yml` when you push a version tag (e.g. `v1.0.0`):

- `HumanTyper-Windows.zip`
- `HumanTyper-macOS-AppleSilicon.zip`
- `HumanTyper-macOS-Intel.zip`

`releases/latest/download/...` always points at your newest release, so you
don't have to touch the site when you ship an update — just push a new tag.
