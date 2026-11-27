-- Human Typer sale-pool fix. Run ONCE in the Supabase SQL editor, after
-- supabase_ai_migration.sql. Idempotent: safe to re-run.
--
-- The bug: activate_key bound any key to a device without marking it sold, so a
-- key handed to someone by hand stayed in the sale pool. Checkout could then
-- email that same key to a paying buyer, who got "already activated on another
-- device", and a monthly sale also rewrote the first holder's lifetime key into
-- a 30-day pass.
--
-- What it does:
--   1. Drops the old 3-arg claim_or_renew_monthly / claim_keys. Re-running
--      supabase_schema.sql brings them back next to the 4-arg ones, and then the
--      API's RPC call (sent without p_plan) is ambiguous and fails.
--   2. claim_or_renew_monthly + claim_keys only pick pool keys that are not
--      bound to a device and were never activated (an old admin unbind cleared
--      device_id but left the key unsold; activated_at still marks it).
--   3. activate_key marks a key sold when it binds it, and when it re-checks an
--      unsold key on the same device. An activated key has been handed to
--      someone, so it leaves the sale pool.
--   4. replace_key(p_key, p_new): gives a buyer a fresh key when someone else
--      holds theirs. The buyer, payment ref and payment ledger move to the new
--      key, so renewals and payment replays land there; the old key stays with
--      its device. The admin page calls it ("new key" button).
--   5. double_sold_keys(): monthly sales where the key was already activated
--      before the payment. The admin page lists them ("double-sold" filter).
--   6. One-time cleanup: every key still in the pool that is bound, or was
--      ever activated, is marked sold.
--   7. Last result: the same list as double_sold_keys, with emails and dates
--      (see the note at the bottom).

begin;

-- Fail fast instead of queueing live activations and claims behind this
-- migration; on a timeout the whole transaction rolls back, just re-run it.
set local lock_timeout = '3s';

-- 1. Old overloads ------------------------------------------------------------
drop function if exists public.claim_or_renew_monthly(text, text, int);
drop function if exists public.claim_keys(text, text, int);

-- 2a. Monthly-like claim/renew: never picks a bound or once-activated key ----
create or replace function public.claim_or_renew_monthly(
  p_email text, p_ref text, p_days int default 30, p_plan text default 'monthly')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d      int := greatest(coalesce(p_days, 30), 1);
  k      text;
  cur    timestamptz;
  newexp timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(p_ref));
  perform pg_advisory_xact_lock(hashtext(lower(p_email)));

  -- Already applied this payment? Return the same key + current expiry.
  select lp.key into k from public.license_payments lp where lp.payment_ref = p_ref;
  if k is not null then
    select expires_at into newexp from public.licenses where key = k;
    return jsonb_build_object('key', k, 'new', false, 'expires_at', newexp);
  end if;

  -- The buyer's existing key OF THIS PLAN (freshest), if any.
  select l.key, l.expires_at into k, cur
    from public.licenses l
    where l.plan = p_plan and l.status = 'active' and lower(l.email) = lower(p_email)
    order by l.expires_at desc nulls last, l.key asc
    limit 1
    for update;

  if k is null then
    -- First purchase of this plan: claim a fresh unsold key. A key that
    -- is bound, or was ever activated, was handed to someone: never sold.
    select l.key into k from public.licenses l
      where l.sold = false and l.status = 'active' and l.device_id is null
        and l.activated_at is null
      order by l.created_at limit 1 for update skip locked;
    if k is null then
      return jsonb_build_object('key', null, 'new', false, 'expires_at', null); -- pool empty
    end if;
    newexp := now() + make_interval(days => d);
    update public.licenses
      set sold = true, plan = p_plan, email = p_email,
          payment_ref = p_ref, expires_at = newexp
      where key = k;
  else
    -- Renewal: stack onto remaining time, or restart from now if lapsed.
    newexp := greatest(coalesce(cur, now()), now()) + make_interval(days => d);
    update public.licenses set expires_at = newexp, email = p_email where key = k;
  end if;

  insert into public.license_payments(payment_ref, key, email, days)
    values (p_ref, k, p_email, d);
  return jsonb_build_object('key', k, 'new', true, 'expires_at', newexp);
end $$;

-- 2b. Volume/lifetime claim: never picks a bound or once-activated key -------
create or replace function public.claim_keys(
  p_email text, p_ref text, p_qty int, p_plan text default 'lifetime')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n int := greatest(coalesce(p_qty, 1), 1);
  existing jsonb;
  ks text[];
begin
  perform pg_advisory_xact_lock(hashtext(p_ref));

  -- Already fulfilled? Return the SAME keys; never allocate more for this ref.
  select coalesce(jsonb_agg(key order by key), '[]'::jsonb) into existing
    from public.licenses where payment_ref = p_ref;
  if jsonb_array_length(existing) > 0 then
    return jsonb_build_object('keys', existing,
                              'count', jsonb_array_length(existing), 'new', false);
  end if;

  with picked as (
    select key from public.licenses
      where sold = false and status = 'active' and device_id is null and activated_at is null
      order by created_at limit n for update skip locked
  ), claimed as (
    update public.licenses l
      set sold = true, email = p_email, payment_ref = p_ref, plan = p_plan
      from picked where l.key = picked.key
      returning l.key
  )
  select array_agg(key order by key) into ks from claimed;

  if ks is null then
    return jsonb_build_object('keys', '[]'::jsonb, 'count', 0, 'new', false);
  end if;
  return jsonb_build_object('keys', to_jsonb(ks),
                            'count', cardinality(ks), 'new', true);
end $$;

-- 3. activate_key: an activated key leaves the sale pool ----------------------
create or replace function public.activate_key(p_key text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r    public.licenses;
  v_ai boolean;
begin
  select * into r from public.licenses where canon(key) = canon(p_key) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  v_ai := coalesce(r.ai_enabled, r.plan in ('ai_monthly', 'ai_lifetime'));
  if r.expires_at is not null and r.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'plan', r.plan, 'expires_at', r.expires_at, 'ai', v_ai);
  end if;
  if r.device_id is null then
    update public.licenses set device_id = p_device, activated_at = now(), sold = true
      where key = r.key;
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at, 'ai', v_ai);
  elsif r.device_id = p_device then
    if not r.sold then
      update public.licenses set sold = true where key = r.key;
    end if;
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at, 'ai', v_ai);
  else
    return jsonb_build_object('ok', false, 'reason', 'in_use');
  end if;
end $$;

-- Only service_role (the Vercel API) may call these; the public/anon key stays
-- shut out.
revoke all on function public.claim_or_renew_monthly(text, text, int, text) from public, anon, authenticated;
revoke all on function public.claim_keys(text, text, int, text)             from public, anon, authenticated;
grant execute on function public.claim_or_renew_monthly(text, text, int, text) to service_role;
grant execute on function public.claim_keys(text, text, int, text)             to service_role;
revoke all on function public.activate_key(text, text) from public, anon, authenticated;
grant execute on function public.activate_key(text, text) to service_role;

-- 4. Repair path for buyers who were sold a key someone else holds ------------
-- Gives a buyer a fresh key when someone else holds theirs. The old key keeps
-- its device; the buyer, the payment ref and the payment ledger move to the new one.
create or replace function public.replace_key(p_key text, p_new text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r         public.licenses;
  v_email   text;
  v_paid    timestamptz;
  v_restore boolean;
begin
  -- Same lock order as claim_or_renew_monthly: buyer email first, then the row.
  select email into v_email from public.licenses where key = p_key;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext(lower(v_email)));
  end if;
  select * into r from public.licenses where key = p_key for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if not r.sold or r.email is null then
    return jsonb_build_object('ok', false, 'reason', 'no_buyer');
  end if;
  -- Bound before its first payment, and not issued by hand (a MANUAL- key is
  -- activated before an online renewal too), means it was a hand-out the sale
  -- overwrote, so it goes back to what a pool key is: lifetime, no expiry.
  -- Otherwise its plan is left alone (never a free upgrade).
  select min(processed_at) into v_paid from public.license_payments where key = r.key;
  v_restore := v_paid is not null and r.activated_at is not null and r.activated_at < v_paid
               and coalesce(r.payment_ref, '') not like 'MANUAL-%';

  insert into public.licenses(key, sold, plan, email, payment_ref, expires_at)
    values (p_new, true, r.plan, r.email, r.payment_ref, r.expires_at);
  update public.license_payments set key = p_new where key = r.key;
  update public.licenses
    set email = null, payment_ref = null,
        plan = case when v_restore then 'lifetime' else plan end,
        expires_at = case when v_restore then null else expires_at end
    where key = r.key;
  return jsonb_build_object('ok', true, 'key', p_new, 'plan', r.plan, 'email', r.email,
                            'expires_at', r.expires_at, 'old_restored', v_restore);
end $$;

-- 5. Keys that were bound to a device before their first payment (monthly plans).
create or replace function public.double_sold_keys()
returns setof text language sql stable security definer set search_path = public as $$
  select l.key
    from public.licenses l
    join (select key, min(processed_at) as first_paid_at
            from public.license_payments group by key) p on p.key = l.key
   where l.activated_at is not null and l.activated_at < p.first_paid_at
     and coalesce(l.payment_ref, '') not like 'MANUAL-%'
   order by p.first_paid_at desc
$$;

revoke all on function public.replace_key(text, text) from public, anon, authenticated;
revoke all on function public.double_sold_keys()      from public, anon, authenticated;
grant execute on function public.replace_key(text, text) to service_role;
grant execute on function public.double_sold_keys()      to service_role;

-- 6. One-time cleanup: pool keys that are bound or were ever activated ---------
update public.licenses set sold = true
  where sold = false and (device_id is not null or activated_at is not null);

commit;

-- 7. Monthly sales where the key was already activated before the payment.
-- The buyer on each row was most likely emailed a key someone else holds.
-- Lifetime sales cannot be detected from the data (they have no sale
-- timestamp), so this list can miss them. Keys issued by hand (MANUAL- ref)
-- and renewed online later are left out. Fix each row on the admin page:
-- "double-sold" filter, press "new key".
select l.key, l.email, l.plan, l.activated_at as bound_at, p.first_paid_at
  from public.licenses l
  join (select key, min(processed_at) as first_paid_at
          from public.license_payments group by key) p on p.key = l.key
 where l.activated_at is not null and l.activated_at < p.first_paid_at
   and coalesce(l.payment_ref, '') not like 'MANUAL-%'
 order by p.first_paid_at desc;
