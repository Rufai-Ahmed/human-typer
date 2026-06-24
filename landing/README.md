# Human Typer — landing page

Static marketing + sales page for `humantypist.rufaiahmed.com`. Sells a
**one-time ₦10,000 lifetime license** via Paystack; the app itself is gated by a
license key (see the repo root). Pure static — no server, no env vars needed.

```
landing/
  index.html   marketing, pricing (Paystack), free download links
  styles.css   styling (on-brand, GPU-light)
  app.js       typing demo + Paystack checkout
  icon.png     favicon / social image
```

## How buying works

1. Buyer enters their email and clicks **Buy lifetime access** → Paystack popup
   (uses your **public** key `pk_live_…`, charges ₦10,000 / 1,000,000 kobo).
2. On success the page tells them their key is coming by email.
3. You confirm the payment in your **Paystack dashboard**, then email them one of
   the keys from `LICENSE_KEYS.txt` (your Google Doc). This is manual fulfilment.
4. They download the free app and paste the key to activate it forever.

> **Keys:** `python gen_licenses.py 50` (repo root) makes the keys. Plaintext
> lives in `LICENSE_KEYS.txt` (gitignored — your Google Doc); only the SHA-256
> hashes ship inside the app (`licenses.py`). To add more later without breaking
> issued keys: `python gen_licenses.py --add 50` then rebuild + release.

## Security notes

- Only the Paystack **public** key (`pk_live_…`) is in the page — that's safe and
  intended. NEVER put the **secret** key (`sk_live_…`) in the repo or the page.
- Download links point at the public GitHub release, so anyone with a link can
  download the app — but it's useless without a paid license key, so that's fine.

## Deploy to Vercel

1. Import the repo. **Root Directory = `landing`**, Framework = **Other** (static).
2. No environment variables required.
3. Deploy, then **Settings → Domains → Add** `humantypist.rufaiahmed.com` and add
   the CNAME it shows to your `rufaiahmed.com` DNS.

## Auto-deliver keys later (optional upgrade)

Manual fulfilment is fine to start. To automate: add a Vercel serverless function
that verifies the Paystack transaction with your **secret** key (server-side env
var) and returns/east-emails a key from a store (Vercel KV / Upstash). Ask and I
can wire it up.
