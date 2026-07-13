-- Human Typer AI feature migration. Run ONCE in the Supabase SQL editor.
-- Idempotent: safe to re-run. Adds the AI plans and the per-key AI override.
--
-- What it does:
--   1. ai_enabled override column (null = plan default, true/false = owner forces it)
--   2. claim_or_renew_monthly + claim_keys gain a p_plan arg (so ai_monthly /
--      ai_lifetime keys store the right plan). The old signatures are dropped and
--      replaced with defaulted ones, so the API's existing calls (no p_plan) still
--      work unchanged. Drop+create is one fast transaction; a payment landing in the
--      sub-second window just retries via the provider webhook.
--   3. activate_key returns "ai": the effective AI flag the desktop app gates on.
--
-- Effective AI = coalesce(ai_enabled, plan in ('ai_monthly','ai_lifetime')).
-- So: ai_enabled=true grants AI to any key (your own machine, a comp);
--     ai_enabled=false revokes AI even from an AI plan; null = follow the plan.

begin;

-- Fail fast instead of jamming the money path: the ALTER below takes an ACCESS
-- EXCLUSIVE lock on licenses, and a live activate_key / claim_* holding a row lock
-- would make it block AND queue every following activation/claim behind it. With a
-- short lock_timeout the whole (atomic) migration just rolls back and you re-run it;
-- nothing is half-applied. Best run during a quiet moment regardless.
set local lock_timeout = '3s';
set local idle_in_transaction_session_timeout = '10s';

-- 1. Override column ---------------------------------------------------------
alter table public.licenses add column if not exists ai_enabled boolean;

-- 2a. Monthly-like claim/renew, now plan-aware --------------------------------
drop function if exists public.claim_or_renew_monthly(text, text, int);
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
    -- First purchase of this plan: claim a fresh unsold key.
    select l.key into k from public.licenses l
      where l.sold = false and l.status = 'active'
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

-- 2b. Volume/lifetime claim, now plan-aware -----------------------------------
drop function if exists public.claim_keys(text, text, int);
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
      where sold = false and status = 'active'
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

-- 3. activate_key now reports the effective AI flag ---------------------------
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
    update public.licenses set device_id = p_device, activated_at = now() where key = r.key;
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at, 'ai', v_ai);
  elsif r.device_id = p_device then
    return jsonb_build_object('ok', true, 'plan', r.plan, 'expires_at', r.expires_at, 'ai', v_ai);
  else
    return jsonb_build_object('ok', false, 'reason', 'in_use');
  end if;
end $$;

-- Re-lock the recreated functions: only service_role (the Vercel API) may call
-- them; the public/anon key stays shut out. Mirrors the base schema's pattern,
-- plus an explicit service_role grant so the drop+recreate can't strand access.
revoke all on function public.claim_or_renew_monthly(text, text, int, text) from public, anon, authenticated;
revoke all on function public.claim_keys(text, text, int, text)             from public, anon, authenticated;
grant execute on function public.claim_or_renew_monthly(text, text, int, text) to service_role;
grant execute on function public.claim_keys(text, text, int, text)             to service_role;

-- 4. Per-key daily usage cap for the shared free Gemini key ------------------
create table if not exists public.ai_usage (
  key   text not null,
  day   date not null default current_date,
  count int  not null default 0,
  primary key (key, day)
);
alter table public.ai_usage enable row level security;  -- service_role only

-- Atomically count one use and report whether it is within the daily cap.
-- Keys by canon() so it matches however the app formats the key.
create or replace function public.ai_bump(p_key text, p_max int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.ai_usage(key, day, count)
    values (canon(p_key), current_date, 1)
    on conflict (key, day) do update set count = public.ai_usage.count + 1
    returning count into c;
  return jsonb_build_object('count', c, 'ok', c <= greatest(coalesce(p_max, 200), 1));
end $$;
revoke all on function public.ai_bump(text, int) from public, anon, authenticated;
grant execute on function public.ai_bump(text, int) to service_role;

commit;

-- Grant AI to a specific key (e.g. YOUR OWN machine's key), or revoke it:
--   update public.licenses set ai_enabled = true  where key = 'HT-XXXXX-XXXXX-XXXXX';
--   update public.licenses set ai_enabled = false where key = 'HT-XXXXX-XXXXX-XXXXX';
--   update public.licenses set ai_enabled = null  where key = 'HT-XXXXX-XXXXX-XXXXX';  -- follow plan
