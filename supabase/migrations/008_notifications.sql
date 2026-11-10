-- 008 — Clinic email notifications (daily recap + "needs your attention" alerts).
--
-- Per Jeff (Nov 10 call): clinics should rarely need to log in. Each clinic gets
--   • a daily recap at a set local hour (default 8 AM): how many were verified, how many
--     need attention, breakdown by insurer, high-deductible and low-copay counts;
--   • an alert when patients need staff attention (at most every 3 hours, business hours).
-- Emails go out through Resend from the Apps Script engine. Resend is NOT HIPAA-covered,
-- so emails carry counts and insurer names only — never patient names, DOBs or member IDs.
--
-- Admins manage settings through RPCs; the engine reads/writes with the service role.

-- ───────────── tables ─────────────
create table if not exists public.notification_settings (
  practice_id                uuid primary key references public.practices(id) on delete cascade,
  recipients                 text[]  not null default '{}',
  daily_recap                boolean not null default true,
  attention_alerts           boolean not null default true,
  recap_hour                 smallint not null default 8 check (recap_hour between 0 and 23),
  high_deductible_threshold  numeric not null default 2500 check (high_deductible_threshold >= 0),
  low_copay_threshold        numeric not null default 40   check (low_copay_threshold >= 0),
  last_recap_on              date,          -- clinic-local date of the last recap sent
  last_attention_at          timestamptz,   -- when the last attention alert went out
  updated_at                 timestamptz not null default now()
);

create table if not exists public.notification_log (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references public.practices(id) on delete cascade,
  kind          text not null check (kind in ('daily_recap', 'attention', 'test')),
  status        text not null default 'requested' check (status in ('requested', 'sent', 'skipped', 'failed')),
  recipients    text[] not null default '{}',
  subject       text,
  metrics       jsonb,
  error         text,
  requested_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index if not exists notification_log_practice_idx on public.notification_log (practice_id, created_at desc);
create index if not exists notification_log_requested_idx on public.notification_log (status) where status = 'requested';

alter table public.notification_settings enable row level security;
alter table public.notification_log      enable row level security;
-- No policies: only the RPCs below (admins) and the service role (engine) touch these.

-- ───────────── helpers ─────────────
create or replace function public.iv_num(v jsonb)
returns numeric language sql immutable as $$
  select case when (v #>> '{}') ~ '^-?\d+(\.\d+)?$' then (v #>> '{}')::numeric end
$$;

-- Statuses that need someone at the clinic to act.
create or replace function public.iv_attention_statuses()
returns text[] language sql immutable as $$
  select array['needs_practice_data', 'needs_enrollment', 'needs_human', 'failed', 'inactive_coverage']
$$;

-- Counts only — no patient identifiers. Window = (p_since, p_until].
-- "Open attention" = items still waiting on the clinic for upcoming/recent visits
-- (date of service yesterday or later, or no date and created in the last 14 days).
create or replace function public.iv_practice_recap(
  p_practice_id uuid, p_since timestamptz default now() - interval '24 hours', p_until timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s        public.notification_settings;
  p        public.practices;
  hi       numeric; lo numeric;
  att      text[] := public.iv_attention_statuses();
  result   jsonb;
begin
  select * into p from public.practices where id = p_practice_id;
  if p.id is null then raise exception 'Clinic not found'; end if;
  select * into s from public.notification_settings where practice_id = p_practice_id;
  hi := coalesce(s.high_deductible_threshold, 2500);
  lo := coalesce(s.low_copay_threshold, 40);

  with fin as (   -- finished in the window
    select v.id, v.status, v.stedi_payer_id, v.payer_name_raw,
           coalesce(pb.name, nullif(v.payer_name_raw, ''), v.stedi_payer_id) as insurer,
           vv.vals
    from public.verifications v
    left join public.payer_playbooks pb on pb.stedi_payer_id = v.stedi_payer_id
    left join public.verification_values vv on vv.verification_id = v.id
    where v.practice_id = p_practice_id
      and v.status not in ('queued', 'running')
      and coalesce(v.completed_at, v.updated_at) > p_since
      and coalesce(v.completed_at, v.updated_at) <= p_until
  ), ver as (
    select * from fin where status = 'complete'
  ), ins as (
    select insurer,
           count(*) as finished,
           count(*) filter (where status = 'complete') as verified,
           count(*) filter (where status = any(att)) as needs_attention
    from fin group by insurer
  )
  select jsonb_build_object(
    'practice_id', p.id,
    'practice_name', p.name,
    'timezone', p.timezone,
    'since', p_since, 'until', p_until,
    'thresholds', jsonb_build_object('high_deductible', hi, 'low_copay', lo),
    'uploaded', (select count(*) from public.verifications v
                 where v.practice_id = p_practice_id and v.created_at > p_since and v.created_at <= p_until),
    'finished', (select count(*) from fin),
    'verified', (select count(*) from ver),
    'inactive', (select count(*) from fin where status = 'inactive_coverage'),
    'needs_attention_new', (select count(*) from fin where status = any(att)),
    'needs_attention_open', (select count(*) from public.verifications v
                             where v.practice_id = p_practice_id and v.status = any(att)
                               and (v.date_of_service >= current_date - 1
                                    or (v.date_of_service is null and v.created_at > now() - interval '14 days'))),
    'still_working', (select count(*) from public.verifications v
                      where v.practice_id = p_practice_id and v.status in ('queued', 'running')),
    'high_deductible', (select count(*) from ver where public.iv_num(vals->'deductible_total') >= hi),
    'deductible_met', (select count(*) from ver where public.iv_num(vals->'deductible_remaining') = 0),
    'low_copay', (select count(*) from ver where public.iv_num(vals->'copay') is not null
                                             and public.iv_num(vals->'copay') < lo),
    'coinsurance_plans', (select count(*) from ver where vals->>'benefit_type' = 'coinsurance'),
    'auth_required', (select count(*) from ver where lower(vals->>'prior_auth_required') in ('true', 'yes')),
    'avg_copay', (select round(avg(public.iv_num(vals->'copay')), 2) from ver where public.iv_num(vals->'copay') > 0),
    'avg_deductible_remaining', (select round(avg(public.iv_num(vals->'deductible_remaining')), 0) from ver
                                 where public.iv_num(vals->'deductible_remaining') is not null),
    'by_insurer', coalesce((select jsonb_agg(jsonb_build_object('insurer', insurer, 'finished', finished,
                                                                 'verified', verified, 'needs_attention', needs_attention)
                                            order by finished desc, insurer)
                            from ins), '[]'::jsonb)
  ) into result;
  return result;
end $$;

revoke all on function public.iv_practice_recap(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.iv_practice_recap(uuid, timestamptz, timestamptz) to service_role;

-- ───────────── admin RPCs ─────────────
create or replace function public.admin_get_notification_settings(p_practice_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.notification_settings; tz text;
begin
  perform public.iv_require_admin();
  select timezone into tz from public.practices where id = p_practice_id;
  if tz is null then raise exception 'Clinic not found'; end if;
  select * into s from public.notification_settings where practice_id = p_practice_id;
  return jsonb_build_object(
    'practice_id', p_practice_id,
    'timezone', tz,
    'configured', s.practice_id is not null,
    'recipients', to_jsonb(coalesce(s.recipients, '{}')),
    'daily_recap', coalesce(s.daily_recap, true),
    'attention_alerts', coalesce(s.attention_alerts, true),
    'recap_hour', coalesce(s.recap_hour, 8),
    'high_deductible_threshold', coalesce(s.high_deductible_threshold, 2500),
    'low_copay_threshold', coalesce(s.low_copay_threshold, 40),
    'last_recap_on', s.last_recap_on,
    'last_attention_at', s.last_attention_at
  );
end $$;

create or replace function public.admin_save_notification_settings(
  p_practice_id uuid,
  p_recipients text[],
  p_daily_recap boolean default true,
  p_attention_alerts boolean default true,
  p_recap_hour int default 8,
  p_high_deductible_threshold numeric default 2500,
  p_low_copay_threshold numeric default 40,
  p_timezone text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare clean text[]; bad text;
begin
  perform public.iv_require_admin();
  if not exists (select 1 from public.practices where id = p_practice_id) then raise exception 'Clinic not found'; end if;

  select coalesce(array_agg(distinct lower(trim(e))), '{}') into clean
  from unnest(coalesce(p_recipients, '{}')) e where trim(e) <> '';
  select e into bad from unnest(clean) e where e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' limit 1;
  if bad is not null then raise exception 'Not a valid email address: %', bad; end if;
  if cardinality(clean) > 10 then raise exception 'Up to 10 recipients per clinic'; end if;
  if p_recap_hour not between 0 and 23 then raise exception 'Send hour must be 0–23'; end if;
  if p_timezone is not null and not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Unknown time zone: %', p_timezone;
  end if;

  if p_timezone is not null then
    update public.practices set timezone = p_timezone where id = p_practice_id;
  end if;

  insert into public.notification_settings as ns (practice_id, recipients, daily_recap, attention_alerts, recap_hour,
                                                  high_deductible_threshold, low_copay_threshold, updated_at)
  values (p_practice_id, clean, coalesce(p_daily_recap, true), coalesce(p_attention_alerts, true), p_recap_hour,
          coalesce(p_high_deductible_threshold, 2500), coalesce(p_low_copay_threshold, 40), now())
  on conflict (practice_id) do update set
    recipients = excluded.recipients, daily_recap = excluded.daily_recap, attention_alerts = excluded.attention_alerts,
    recap_hour = excluded.recap_hour, high_deductible_threshold = excluded.high_deductible_threshold,
    low_copay_threshold = excluded.low_copay_threshold, updated_at = now();

  return public.admin_get_notification_settings(p_practice_id);
end $$;

-- What tomorrow morning's recap would say, using the last 24 hours (or p_days).
create or replace function public.admin_preview_recap(p_practice_id uuid, p_days int default 1)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.iv_require_admin();
  return public.iv_practice_recap(p_practice_id, now() - make_interval(days => greatest(1, least(coalesce(p_days, 1), 31))), now());
end $$;

-- Queue a test recap email; the engine sends it within ~5 minutes.
create or replace function public.admin_request_test_email(p_practice_id uuid)
returns public.notification_log
language plpgsql security definer set search_path = public as $$
declare r public.notification_log; rcpts text[];
begin
  perform public.iv_require_admin();
  select recipients into rcpts from public.notification_settings where practice_id = p_practice_id;
  if coalesce(cardinality(rcpts), 0) = 0 then raise exception 'Add at least one recipient and save first'; end if;
  if exists (select 1 from public.notification_log where practice_id = p_practice_id and status = 'requested') then
    raise exception 'A test email is already on its way';
  end if;
  insert into public.notification_log (practice_id, kind, status, recipients, requested_by)
  values (p_practice_id, 'test', 'requested', rcpts, auth.uid())
  returning * into r;
  return r;
end $$;

create or replace function public.admin_list_notification_log(p_practice_id uuid, p_limit int default 20)
returns setof public.notification_log
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.iv_require_admin();
  return query select * from public.notification_log
               where practice_id = p_practice_id
               order by created_at desc limit greatest(1, least(coalesce(p_limit, 20), 100));
end $$;

revoke all on function public.admin_get_notification_settings(uuid) from public, anon;
revoke all on function public.admin_save_notification_settings(uuid, text[], boolean, boolean, int, numeric, numeric, text) from public, anon;
revoke all on function public.admin_preview_recap(uuid, int) from public, anon;
revoke all on function public.admin_request_test_email(uuid) from public, anon;
revoke all on function public.admin_list_notification_log(uuid, int) from public, anon;
grant execute on function public.admin_get_notification_settings(uuid) to authenticated;
grant execute on function public.admin_save_notification_settings(uuid, text[], boolean, boolean, int, numeric, numeric, text) to authenticated;
grant execute on function public.admin_preview_recap(uuid, int) to authenticated;
grant execute on function public.admin_request_test_email(uuid) to authenticated;
grant execute on function public.admin_list_notification_log(uuid, int) to authenticated;
