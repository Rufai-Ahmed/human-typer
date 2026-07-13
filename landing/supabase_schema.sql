-- Human Typer licensing — run this once in the Supabase SQL editor.
-- AFTER this, also run supabase_ai_migration.sql to add the AI plans/override.
--
-- All access is via the functions below, called by the Vercel API using the
-- SERVICE_ROLE key (which bypasses RLS). The table itself is locked down (RLS on,
-- no policies), so the public/publishable key can neither read nor write it.

create table if not exists public.licenses (
  key          text primary key,
  status       text not null default 'active',   -- 'active' | 'revoked'
  sold         boolean not null default false,    -- claimed via a payment
  email        text,
  payment_ref  text,
  device_id    text,                              -- bound machine (null until activated)
  plan         text not null default 'lifetime', -- monthly | ai_monthly | lifetime | ai_lifetime
  expires_at   timestamptz,                       -- null = never expires (lifetime); set for monthly
  ai_enabled   boolean,                           -- override: null=plan default, true/false=forced
  activated_at timestamptz,
  created_at   timestamptz not null default now()
);

-- For deployments created before these columns existed: add them.
alter table public.licenses add column if not exists plan       text not null default 'lifetime';
alter table public.licenses add column if not exists expires_at timestamptz;
alter table public.licenses add column if not exists ai_enabled boolean;

-- Ledger of every monthly payment, so renewals are idempotent per Paystack reference
-- (the browser callback + webhook can both fire for one payment) and auditable.
create table if not exists public.license_payments (
  payment_ref  text primary key,
  key          text references public.licenses(key),
  email        text,
  days         int,
  processed_at timestamptz not null default now()
);

alter table public.licenses enable row level security;
alter table public.license_payments enable row level security;
-- (no policies on purpose => anon/publishable key has zero access to these tables)

-- Canonical form: alphanumerics only, uppercased. Matches the app's _normalize_key
-- and gen_licenses.py, so dashes/case/spacing in a pasted key never matter.
create or replace function public.canon(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Activate (bind) a key to one device. Returns {ok, reason?, plan, expires_at}.
--   reasons: invalid | revoked | in_use | expired
-- plan/expires_at are returned on success AND on 'expired' so the app can store the
-- expiry (offline enforcement) and auto-recover when a monthly pass is renewed.
create or replace function public.activate_key(p_key text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.licenses;
begin
  select * into r from public.licenses where canon(key) = canon(p_key) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  -- A monthly pass that has lapsed: keep the binding, just report expired.
  if r.expires_at is not null and r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'plan', r.plan, 'expires_at', r.expires_at);
  end if;
  if r.device_id is null then
    update public.licenses set device_id = p_device, activated_at = now() where key = r.key;
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at);
  elsif r.device_id = p_device then
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at);
  else
    return jsonb_build_object('ok', false, 'reason', 'in_use');
  end if;
end $$;

-- Atomically hand out one unsold key for a paid order. Idempotent per payment_ref.
-- Returns {key, new} ; key is null if the pool is empty.
create or replace function public.claim_key(p_email text, p_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text;
begin
  -- serialize concurrent calls for the same payment (client callback + webhook)
  perform pg_advisory_xact_lock(hashtext(p_ref));
  select key into k from public.licenses where payment_ref = p_ref limit 1;
  if k is not null then return jsonb_build_object('key', k, 'new', false); end if;

  select key into k from public.licenses
    where sold = false and status = 'active'
    order by created_at limit 1 for update skip locked;
  if k is null then return jsonb_build_object('key', null, 'new', false); end if;

  update public.licenses set sold = true, email = p_email, payment_ref = p_ref where key = k;
  return jsonb_build_object('key', k, 'new', true);
end $$;

-- Atomically hand out up to p_qty unsold keys for one paid order (team/volume packs).
-- Idempotent per payment_ref: a repeat call for the same payment returns the SAME set
-- of keys and never allocates more (so the client callback + Paystack webhook can both
-- fire without double-allocating). Returns {keys: jsonb array, count, new}. `keys` may
-- be SHORTER than p_qty if the pool runs dry; the caller emails what it gets and is
-- alerted to top up. Each returned key is an ordinary 1-device license.
create or replace function public.claim_keys(p_email text, p_ref text, p_qty int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n int := greatest(coalesce(p_qty, 1), 1);
  existing jsonb;
  ks text[];
begin
  -- serialize concurrent calls for the same payment (client callback + webhook)
  perform pg_advisory_xact_lock(hashtext(p_ref));

  -- Already fulfilled? Return the SAME keys; never allocate more for this ref.
  select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into existing
    from public.licenses where payment_ref = p_ref;
  if jsonb_array_length(existing) > 0 then
    return jsonb_build_object('keys', existing,
                              'count', jsonb_array_length(existing),
                              'new', false);
  end if;

  -- Grab up to n available keys, skipping rows another transaction holds.
  with picked as (
    select key from public.licenses
      where sold = false and status = 'active'
      order by created_at
      limit n
      for update skip locked
  ), claimed as (
    update public.licenses l
      set sold = true, email = p_email, payment_ref = p_ref
      from picked
      where l.key = picked.key
      returning l.key
  )
  select array_agg(key order by key) into ks from claimed;

  if ks is null then
    return jsonb_build_object('keys', '[]'::jsonb, 'count', 0, 'new', false);
  end if;
  return jsonb_build_object('keys', to_jsonb(ks),
                            'count', cardinality(ks),
                            'new', true);
end $$;

-- Monthly pass: one ₦2,000 payment buys p_days (30) of access. A buyer keeps ONE
-- monthly key; paying again EXTENDS that key's expiry instead of handing out a new
-- one. Idempotent per payment_ref via the license_payments ledger (browser callback +
-- webhook fire the same ref, so only the first applies). Renewing before expiry stacks
-- the days; renewing after expiry restarts from now. Returns {key, new, expires_at};
-- key is null only if the pool of unsold keys is empty on a first purchase.
create or replace function public.claim_or_renew_monthly(p_email text, p_ref text, p_days int default 30)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d      int := greatest(coalesce(p_days, 30), 1);
  k      text;
  cur    timestamptz;
  newexp timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_ref));
  -- Also serialize per buyer: two concurrent FIRST purchases for the same email (no
  -- row to lock yet) must not each claim a separate key. One monthly key per buyer.
  perform pg_advisory_xact_lock(hashtext(lower(p_email)));

  -- Already applied this payment? Return the same key + current expiry, no extension.
  select lp.key into k from public.license_payments lp where lp.payment_ref = p_ref;
  if k is not null then
    select expires_at into newexp from public.licenses where key = k;
    return jsonb_build_object('key', k, 'new', false, 'expires_at', newexp);
  end if;

  -- The buyer's existing monthly key (the freshest one), if any.
  select l.key, l.expires_at into k, cur
    from public.licenses l
    where l.plan = 'monthly' and l.status = 'active' and lower(l.email) = lower(p_email)
    order by l.expires_at desc nulls last, l.key asc
    limit 1
    for update;

  if k is null then
    -- First monthly purchase: claim a fresh unsold key as this buyer's monthly key.
    select l.key into k from public.licenses l
      where l.sold = false and l.status = 'active'
      order by l.created_at limit 1 for update skip locked;
    if k is null then
      return jsonb_build_object('key', null, 'new', false, 'expires_at', null);  -- pool empty
    end if;
    newexp := now() + make_interval(days => d);
    update public.licenses
      set sold = true, plan = 'monthly', email = p_email,
          payment_ref = p_ref, expires_at = newexp
      where key = k;
  else
    -- Renewal: stack onto remaining time, or restart from now if already lapsed.
    newexp := greatest(coalesce(cur, now()), now()) + make_interval(days => d);
    update public.licenses set expires_at = newexp, email = p_email where key = k;
  end if;

  insert into public.license_payments(payment_ref, key, email, days)
    values (p_ref, k, p_email, d);
  return jsonb_build_object('key', k, 'new', true, 'expires_at', newexp);
end $$;

-- Only the service_role (the Vercel API) may call these; lock out the public key.
revoke all on function public.activate_key(text, text)        from public, anon, authenticated;
revoke all on function public.claim_key(text, text)           from public, anon, authenticated;
revoke all on function public.claim_keys(text, text, int)     from public, anon, authenticated;
revoke all on function public.claim_or_renew_monthly(text, text, int) from public, anon, authenticated;

-- To REVOKE a key later (kills it on next online check / blocks new activation):
--   update public.licenses set status = 'revoked' where key = 'HT-XXXXX-XXXXX-XXXXX';
-- To move a buyer to a new machine (clear the binding):
--   update public.licenses set device_id = null where key = 'HT-XXXXX-XXXXX-XXXXX';

-- Team / volume orders (one payment_ref => several keys):
--   select payment_ref, count(*) as keys, max(email) as email
--     from public.licenses where sold group by payment_ref order by count(*) desc;
--   select key, email from public.licenses where payment_ref = '<ref>';   -- one order's keys
-- Re-confirm only service_role (the Vercel API) may call the volume function:
--   revoke all on function public.claim_keys(text, text, int) from public, anon, authenticated;
-- Inspect grants on it:
--   select proname, proacl from pg_proc where proname = 'claim_keys';
