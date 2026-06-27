-- Human Typer licensing — run this once in the Supabase SQL editor.
--
-- All access is via the two functions below, called by the Vercel API using the
-- SERVICE_ROLE key (which bypasses RLS). The table itself is locked down (RLS on,
-- no policies), so the public/publishable key can neither read nor write it.

create table if not exists public.licenses (
  key          text primary key,
  status       text not null default 'active',   -- 'active' | 'revoked'
  sold         boolean not null default false,    -- claimed via a Paystack payment
  email        text,
  payment_ref  text,
  device_id    text,                              -- bound machine (null until activated)
  activated_at timestamptz,
  created_at   timestamptz not null default now()
);

alter table public.licenses enable row level security;
-- (no policies on purpose => anon/publishable key has zero access to this table)

-- Canonical form: alphanumerics only, uppercased. Matches the app's _normalize_key
-- and gen_licenses.py, so dashes/case/spacing in a pasted key never matter.
create or replace function public.canon(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Activate (bind) a key to one device. Returns {ok, reason}.
--   reasons: invalid | revoked | in_use
create or replace function public.activate_key(p_key text, p_device text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.licenses;
begin
  select * into r from public.licenses where canon(key) = canon(p_key) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.status = 'revoked' then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if r.device_id is null then
    update public.licenses set device_id = p_device, activated_at = now() where key = r.key;
    return jsonb_build_object('ok', true);
  elsif r.device_id = p_device then
    return jsonb_build_object('ok', true);           -- same machine re-checking; fine
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

-- Only the service_role (the Vercel API) may call these; lock out the public key.
revoke all on function public.activate_key(text, text)        from public, anon, authenticated;
revoke all on function public.claim_key(text, text)           from public, anon, authenticated;
revoke all on function public.claim_keys(text, text, int)     from public, anon, authenticated;

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
