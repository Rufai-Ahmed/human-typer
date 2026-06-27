# Human Typer — landing + license backend

Marketing/sales page for `humantyper.rufaiahmed.com` plus the serverless backend
that **auto-delivers keys after a Paystack payment** and **activates them online**
(one device per key, revocable). Backed by Supabase.

```
landing/
  index.html          marketing, Paystack checkout, free download links
  styles.css, app.js  styling, typing demo, Paystack popup + /api/claim call
  api/claim.js        Paystack -> verify -> claim a key -> email it (Resend)
  api/activate.js     app calls this to bind a key to one device / check revocation
  supabase_schema.sql run this once in Supabase (table + functions + lockdown)
  seed_supabase.mjs   load LICENSE_KEYS.txt into Supabase
  icon.png
```

## One-time setup

**1. Supabase**
- SQL editor → run `supabase_schema.sql`. It is safe to re-run: it `create or
  replace`s every function (including the new `claim_keys` used by team/volume
  packs) and re-applies the `revoke`s, without touching existing rows.
- Project Settings → API → copy the **service_role** key (SECRET) and the Project URL.

**2. Load keys**
```
python gen_licenses.py 50           # makes LICENSE_KEYS.txt (store in your Google Doc)
SUPABASE_URL=https://<proj>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service_role> \
node landing/seed_supabase.mjs      # idempotent; re-run after gen_licenses.py --add N
```

**3. Resend (email)** — verify the sender domain `updates.rufaiahmed.com` in Resend
(add the DNS records it gives you) and have your `re_…` API key ready.

**4. Vercel** — import the repo, **Root Directory = `landing`**, framework **Other**.
Add environment variables:

| Name | Value |
|---|---|
| `PAYSTACK_SECRET_KEY` | `sk_live_…` (Paystack dashboard) |
| `SUPABASE_URL` | `https://<proj>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role secret |
| `RESEND_API_KEY` | `re_…` |
| `MAIL_FROM` *(optional)* | `Human Typer <keys@updates.rufaiahmed.com>` |
| `ADMIN_EMAIL` *(optional)* | `me@rufaiahmed.com` (alerted if keys run out) |

Then **Settings → Domains → Add** `humantyper.rufaiahmed.com`.

**5. Paystack webhook** — Dashboard → Settings → Webhooks → URL =
`https://humantyper.rufaiahmed.com/api/claim`. (The page already uses your
**public** key for checkout; the secret key stays server-side.)

## How it works

- **Buy:** Paystack popup (public key) charges the selected total and collects the
  email. Single seat is ₦10,000; team/volume packs lower the per-seat price.
- **Deliver:** on success the browser AND the Paystack webhook both call
  `/api/claim`, which **re-verifies the payment with Paystack's secret key**,
  **derives the seat count from the verified amount** (never from the client),
  atomically claims that many unsold keys from Supabase (idempotent per payment),
  and emails them via Resend. Forged calls verify as failed and get nothing.

## Team / volume packs

Each seat is an ordinary 1-device key; buying more seats just lowers the per-seat
price. There is no separate "Pro" tier, it is the same Standard product bought N at
a time. The seat count is derived **only** from the server-verified Paystack amount,
so a buyer can never receive more keys than they paid for (the client-sent quantity
is ignored). Buyers are granted the largest tier whose total they actually covered:

| Seats | Per seat | Amount paid (NGN) | Amount in kobo | Keys delivered |
|---|---|---|---|---|
| 1  | ₦10,000 | ₦10,000  | 1,000,000  | 1  |
| 5  | ₦8,000  | ₦40,000  | 4,000,000  | 5  |
| 10 | ₦7,000  | ₦70,000  | 7,000,000  | 10 |
| 25 | ₦6,000  | ₦150,000 | 15,000,000 | 25 |

`api/claim.js` maps the verified amount back to seats and calls the
`claim_keys(p_email, p_ref, p_qty)` Supabase function, which atomically allocates up
to `p_qty` available keys with `for update skip locked`, is idempotent per payment
ref (returns the same set on the callback + webhook double-fire), and emails all of
them in one message ("each key activates 1 device, share one per teammate"). If the
key pool is short, it sends what is available and emails `ADMIN_EMAIL` to top up.

**Migration:** re-run `supabase_schema.sql` in the Supabase SQL editor (or just the
`claim_keys` function + its `revoke all on function public.claim_keys(text, text, int)
from public, anon, authenticated;`). The existing `claim_key` is left in place. No
app/Vercel env changes are required.
- **Activate:** the app posts the key + a device fingerprint to `/api/activate`,
  which binds the key to that one device. A second device gets `in_use`.
- **Revoke / move device** (Supabase SQL editor):
  ```sql
  update public.licenses set status='revoked'  where key='HT-…';  -- kill a key
  update public.licenses set device_id=null     where key='HT-…';  -- let a buyer re-activate elsewhere
  ```
  Revocation takes effect the next time that app launches with internet.

## Security

- Only the Paystack **public** key and (nothing else) sit in the page. The
  Paystack **secret**, Supabase **service_role**, and Resend keys are server-only
  env vars. The Supabase table has RLS on with no policies, so the publishable
  key can't touch it — all access goes through the two locked-down functions.
- Keys never expire. Sharing is capped by device-binding; a leaked key can be
  revoked. A determined cracker can still patch any desktop binary — online
  activation raises the bar, it isn't DRM nirvana.
