-- Marketing broadcast support: unsubscribe list + per-campaign send log + the
-- audience query. Run once in the Supabase SQL editor. Safe to re-run.
--
-- email_optouts  : anyone who unsubscribed (never emailed marketing again).
-- campaign_sends : who already got a given campaign (idempotent re-runs).

create table if not exists email_optouts (
  email      text primary key,
  created_at timestamptz not null default now()
);

create table if not exists campaign_sends (
  email     text        not null,
  campaign  text        not null,
  sent_at   timestamptz not null default now(),
  primary key (email, campaign)
);

alter table email_optouts  enable row level security;  -- no policies => service_role only
alter table campaign_sends enable row level security;

-- Active buyers who are NOT on an AI plan yet, minus opt-outs and anyone already
-- sent this campaign. A person can own several license rows under one email, so
-- the AI exclusion is done PER EMAIL (exclude the whole address if ANY of their
-- rows is an AI plan or has ai_enabled), not per row. "Active" = has at least one
-- non-revoked row that is lifetime/legacy or an unexpired monthly.
create or replace function marketing_audience(p_campaign text, p_limit int)
returns setof text
language sql
security definer
set search_path = public
as $$
  select e from (
    select distinct lower(l.email) as e
    from licenses l
    where l.email is not null and l.email <> ''
      and coalesce(l.status, '') <> 'revoked'
      and (coalesce(l.plan, 'lifetime') <> 'monthly'
           or l.expires_at is null or l.expires_at > now())
      and not exists (
        select 1 from licenses a
        where lower(a.email) = lower(l.email)
          and (a.plan in ('ai_monthly', 'ai_lifetime') or coalesce(a.ai_enabled, false) = true)
      )
  ) d
  where not exists (select 1 from email_optouts o  where o.email = d.e)
    and not exists (select 1 from campaign_sends s where s.email = d.e and s.campaign = p_campaign)
  order by e
  limit greatest(p_limit, 0);
$$;

create or replace function marketing_audience_count(p_campaign text)
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*) from (
    select distinct lower(l.email) as e
    from licenses l
    where l.email is not null and l.email <> ''
      and coalesce(l.status, '') <> 'revoked'
      and (coalesce(l.plan, 'lifetime') <> 'monthly'
           or l.expires_at is null or l.expires_at > now())
      and not exists (
        select 1 from licenses a
        where lower(a.email) = lower(l.email)
          and (a.plan in ('ai_monthly', 'ai_lifetime') or coalesce(a.ai_enabled, false) = true)
      )
  ) d
  where not exists (select 1 from email_optouts o  where o.email = d.e)
    and not exists (select 1 from campaign_sends s where s.email = d.e and s.campaign = p_campaign);
$$;

revoke execute on function marketing_audience(text, int)   from public, anon, authenticated;
revoke execute on function marketing_audience_count(text)  from public, anon, authenticated;
grant  execute on function marketing_audience(text, int)   to service_role;
grant  execute on function marketing_audience_count(text)  to service_role;
