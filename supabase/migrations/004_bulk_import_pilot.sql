-- IV Engine — 004: bulk CSV import, pilot answer keys + accuracy comparison,
--                  platform admin role, CarePlan Pro fields
--
-- Practice staff upload a CSV in the dashboard, map their columns to ours, run a dry run
-- (validation only), then submit. Each valid row becomes a queued verification. Optional
-- "ak_*" columns hold the practice's own verification results (the answer key), which the
-- pilot_comparison views score against what the engine found.
--
-- _meta: rows are mapped to canonical keys in the browser; all validation happens here.
--        Raw CSV files are never stored.

-- ───────────────────────── platform admin (VELLO) ─────────────────────────
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
-- No policies: only the service role / SQL editor can read or change this table.

create or replace function public.am_i_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- Admins count as members of every practice. Every RLS policy and staff RPC uses this.
create or replace function public.is_practice_member(p_practice uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.practice_members where practice_id = p_practice and user_id = auth.uid())
      or exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- Seed: hello@vello.live is the platform admin (no-op if that user doesn't exist yet).
insert into public.platform_admins (user_id)
select id from auth.users where email = 'hello@vello.live'
on conflict do nothing;

-- ───────────────────────── reference data ─────────────────────────
alter table public.payer_playbooks add column if not exists aliases text[] not null default '{}';
update public.payer_playbooks set aliases = array['UHC','United Healthcare','UnitedHealthcare','United Health Care'] where stedi_payer_id = '87726' and aliases = '{}';
update public.payer_playbooks set aliases = array['Aetna','Aetna Health'] where stedi_payer_id = '60054' and aliases = '{}';
update public.payer_playbooks set aliases = array['Cigna','Cigna Healthcare'] where stedi_payer_id = '62308' and aliases = '{}';
update public.payer_playbooks set aliases = array['Humana'] where stedi_payer_id = '61101' and aliases = '{}';

-- ───────────────────────── verification inputs ─────────────────────────
alter table public.verifications add column if not exists payment_type    text not null default 'insurance';
alter table public.verifications add column if not exists group_number    text;
alter table public.verifications add column if not exists cpt_codes       text[] not null default '{}';
alter table public.verifications add column if not exists date_of_service date;
alter table public.verifications add column if not exists import_batch_id uuid;
alter table public.verifications drop constraint if exists verifications_payment_type_check;
alter table public.verifications add constraint verifications_payment_type_check check (payment_type in ('insurance','cash'));

create table if not exists public.import_batches (
  id             uuid primary key default gen_random_uuid(),
  practice_id    uuid not null references public.practices(id) on delete cascade,
  uploaded_by    uuid references auth.users(id),
  file_name      text,
  purpose        text not null default 'pilot' check (purpose in ('pilot','production')),
  row_count      int not null default 0,
  accepted_count int not null default 0,
  rejected_count int not null default 0,
  skipped_count  int not null default 0,
  column_mapping jsonb,          -- their header → our key (no patient data)
  created_at     timestamptz not null default now()
);
alter table public.import_batches enable row level security;
drop policy if exists import_batches_read on public.import_batches;
create policy import_batches_read on public.import_batches
  for select to authenticated using (public.is_practice_member(practice_id));

do $$ begin
  alter table public.verifications add constraint verifications_import_batch_fk
    foreign key (import_batch_id) references public.import_batches(id) on delete set null;
exception when duplicate_object then null; end $$;

-- The practice's own results for a verification (pilot answer key).
create table if not exists public.pilot_answer_keys (
  verification_id uuid primary key references public.verifications(id) on delete cascade,
  practice_id     uuid not null references public.practices(id) on delete cascade,
  answers         jsonb not null default '{}',   -- { field_key: value }
  how_obtained    text,                          -- portal / phone / EHR, reference #
  minutes_spent   numeric,
  created_at      timestamptz not null default now()
);
alter table public.pilot_answer_keys enable row level security;
drop policy if exists pilot_answer_keys_read on public.pilot_answer_keys;
create policy pilot_answer_keys_read on public.pilot_answer_keys
  for select to authenticated using (public.is_practice_member(practice_id));

-- ───────────────────────── field lists ─────────────────────────
create or replace function public.iv_optional_fields()
returns text[] language sql immutable as $$
  select array['group_number','plan_start','visits_used','carve_out_vendor','payer_messages',
               'insurance_type','coverage_limit_amount','covered_amount']::text[]
$$;

-- Fields the answer key may contain: required + optional + derived.
create or replace function public.iv_answer_fields()
returns text[] language sql immutable as $$
  select public.iv_required_fields() || public.iv_optional_fields()
         || array['benefit_type','deductible_met','visits_remaining']::text[]
$$;

-- ───────────────────────── parsing helpers ─────────────────────────
-- Accepts 1971-01-01, 01/01/1971, 1/1/1971. Returns null if unparseable.
create or replace function public.iv_parse_date(p text)
returns date language plpgsql immutable as $$
declare s text := trim(coalesce(p, ''));
begin
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}$' then return to_date(s, 'YYYY-MM-DD'); end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{4}$' then return to_date(s, 'MM/DD/YYYY'); end if;
  if s ~ '^\d{8}$' then return to_date(s, 'YYYYMMDD'); end if;
  return null;
exception when others then return null;
end $$;

-- "$1,500.00" → 1500 · "20%" → 20 · "Yes" → true · "In network" → "IN_NETWORK" · else trimmed text
create or replace function public.iv_parse_value(p_key text, p text)
returns jsonb language plpgsql immutable as $$
declare s text := trim(coalesce(p, ''));
begin
  if s = '' then return null; end if;
  if lower(s) in ('yes','y','true','required','active') then return 'true'::jsonb; end if;
  if lower(s) in ('no','n','false','not required','inactive') then return 'false'::jsonb; end if;
  if s ~ '^\$?\s*-?[\d,]+(\.\d+)?\s*%?$' then return to_jsonb(replace(regexp_replace(s, '[$%\s]', '', 'g'), ',', '')::numeric); end if;
  if p_key = 'visit_limit' or p_key = 'visits_used' then
    if s ~ '^\d+' then return to_jsonb(substring(s from '^\d+')::numeric); end if;
  end if;
  if p_key = 'network_status' then
    return to_jsonb(case
      when lower(s) ~ 'in.*out|both' then 'IN_AND_OUT_OF_NETWORK'
      when lower(s) ~ '^out|oon' then 'OUT_OF_NETWORK'
      when lower(s) ~ '^in' then 'IN_NETWORK'
      else upper(regexp_replace(s, '\s+', '_', 'g')) end);
  end if;
  if p_key = 'benefit_type' then
    return to_jsonb(case when lower(s) ~ 'co-?ins' then 'coinsurance' when lower(s) ~ 'co-?pay' then 'copay' else lower(s) end);
  end if;
  return to_jsonb(s);
end $$;

-- ───────────────────────── import RPC ─────────────────────────
-- p_rows: array of objects already mapped to canonical keys:
--   first_name, last_name, dob, member_id, payer, group_number, provider_npi, specialty,
--   cpt_codes, date_of_service, external_patient_id, payment_type,
--   subscriber_first_name, subscriber_last_name, subscriber_dob,
--   ak_<field_key> (answer key), ak_how_obtained, ak_minutes
-- p_dry_run = true → validate only, nothing written.
-- Returns { batch_id, dry_run, total, accepted, rejected, skipped, rows: [{row, status, errors[], warnings[]}] }
create or replace function public.import_verifications(
  p_practice_id uuid,
  p_rows        jsonb,
  p_file_name   text default null,
  p_mapping     jsonb default null,
  p_purpose     text default 'pilot',
  p_dry_run     boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  practice   public.practices;
  r          jsonb;
  i          int := 0;
  errs       text[];
  warns      text[];
  results    jsonb := '[]'::jsonb;
  accepted   int := 0; rejected int := 0; skipped int := 0;
  batch_id   uuid;
  v_dob      date; v_dos date; v_sub_dob date;
  v_payer    public.payer_playbooks;
  v_provider public.providers;
  v_profile  text; v_codes text[]; v_cpts text[];
  v_vid      uuid;
  seen       text[] := '{}';
  dedupe_key text;
  ak         jsonb; k text; f text;
  profile_codes constant jsonb := '{"chiro":["33"],"physical_therapy":["PT"],"behavioral_health":["MH"],"office_visit_specialist":["96"]}';
begin
  select * into practice from public.practices where id = p_practice_id;
  if not found or not public.is_practice_member(p_practice_id) then
    raise exception 'Practice not found' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'p_rows must be a JSON array'; end if;
  if jsonb_array_length(p_rows) > 1000 then raise exception 'Max 1000 rows per upload (got %)', jsonb_array_length(p_rows); end if;
  if p_purpose not in ('pilot','production') then raise exception 'purpose must be pilot or production'; end if;

  if not p_dry_run then
    insert into public.import_batches (practice_id, uploaded_by, file_name, purpose, row_count, column_mapping)
    values (p_practice_id, auth.uid(), p_file_name, p_purpose, jsonb_array_length(p_rows), p_mapping)
    returning id into batch_id;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1; errs := '{}'; warns := '{}';
    v_payer := null; v_provider := null; v_vid := null;

    -- cash patients: nothing to verify
    if lower(coalesce(r->>'payment_type', '')) in ('cash','self-pay','self pay','selfpay') then
      skipped := skipped + 1;
      results := results || jsonb_build_object('row', i, 'status', 'skipped', 'errors', '[]'::jsonb, 'warnings', jsonb_build_array('Cash patient — no verification needed'));
      continue;
    end if;

    if coalesce(trim(r->>'first_name'), '') = '' then errs := array_append(errs, 'First name is missing'); end if;
    if coalesce(trim(r->>'last_name'), '') = ''  then errs := array_append(errs, 'Last name is missing'); end if;
    v_dob := public.iv_parse_date(r->>'dob');
    if v_dob is null then errs := array_append(errs, ('Date of birth is missing or not a date: "' || coalesce(r->>'dob','') || '" (use YYYY-MM-DD or MM/DD/YYYY)'));
    elsif v_dob > current_date or v_dob < date '1900-01-01' then errs := array_append(errs, 'Date of birth is out of range'); end if;
    if coalesce(trim(r->>'member_id'), '') = '' then errs := array_append(errs, 'Member ID is missing'); end if;

    -- payer: Stedi payer ID, playbook name, or alias
    if coalesce(trim(r->>'payer'), '') = '' then errs := array_append(errs, 'Payer is missing');
    else
      select * into v_payer from public.payer_playbooks p
       where p.stedi_payer_id = trim(r->>'payer')
          or lower(p.name) = lower(trim(r->>'payer'))
          or exists (select 1 from unnest(p.aliases) a where lower(a) = lower(trim(r->>'payer')))
       limit 1;
      if v_payer.stedi_payer_id is null then errs := array_append(errs, ('Payer not recognized: "' || trim(r->>'payer') || '". Ask VELLO to add it.')); end if;
    end if;

    -- provider: NPI in this practice, or the practice's only provider
    if coalesce(trim(r->>'provider_npi'), '') <> '' then
      select * into v_provider from public.providers where practice_id = p_practice_id and npi = trim(r->>'provider_npi');
      if v_provider.id is null then errs := array_append(errs, ('Provider NPI ' || trim(r->>'provider_npi') || ' is not set up for this practice')); end if;
    else
      if (select count(*) from public.providers where practice_id = p_practice_id) = 1 then
        select * into v_provider from public.providers where practice_id = p_practice_id;
        warns := array_append(warns, 'No provider NPI; used the practice''s only provider');
      else errs := array_append(errs, 'Provider NPI is missing'); end if;
    end if;

    v_profile := coalesce(nullif(lower(trim(r->>'specialty')), ''), practice.specialty_profile);
    v_profile := case when v_profile in ('chiro','chiropractic','dc') then 'chiro'
                      when v_profile in ('pt','physical_therapy','physical therapy') then 'physical_therapy'
                      when v_profile in ('bh','behavioral_health','behavioral health','mental health') then 'behavioral_health'
                      when v_profile in ('specialist','office_visit_specialist') then 'office_visit_specialist'
                      else null end;
    if v_profile is null then errs := array_append(errs, ('Specialty not recognized: "' || coalesce(r->>'specialty','') || '"')); end if;

    if coalesce(trim(r->>'date_of_service'), '') <> '' then
      v_dos := public.iv_parse_date(r->>'date_of_service');
      if v_dos is null then warns := array_append(warns, 'Date of service not understood; left blank'); end if;
    else v_dos := null; end if;

    v_sub_dob := null;
    if coalesce(trim(r->>'subscriber_last_name'), '') <> '' then
      v_sub_dob := public.iv_parse_date(r->>'subscriber_dob');
      if v_sub_dob is null then errs := array_append(errs, 'Patient is a dependent but subscriber DOB is missing or not a date'); end if;
    end if;

    v_cpts := coalesce(array(select trim(x) from regexp_split_to_table(coalesce(r->>'cpt_codes', ''), '[,;\s]+') x where trim(x) <> ''), '{}');

    -- duplicates: within this file, and already-active verifications
    dedupe_key := lower(coalesce(trim(r->>'member_id'), '')) || '|' || coalesce(v_dob::text, '') || '|' || coalesce(v_dos::text, '');
    if dedupe_key = any(seen) then errs := array_append(errs, 'Duplicate of an earlier row in this file');
    elsif v_dob is not null and exists (
      select 1 from public.verifications x
       where x.practice_id = p_practice_id and lower(x.member_id) = lower(trim(r->>'member_id')) and x.patient_dob = v_dob
         and coalesce(x.date_of_service, date '1900-01-01') = coalesce(v_dos, date '1900-01-01')
         and x.status in ('queued','running')) then
      errs := array_append(errs, 'Already being verified (same member, DOB and date of service)');
    end if;
    seen := seen || dedupe_key;

    -- answer key (pilot): ak_<field_key>
    ak := '{}'::jsonb;
    for k in select jsonb_object_keys(r) loop
      if k like 'ak\_%' and k not in ('ak_how_obtained','ak_minutes') then
        f := substring(k from 4);
        if not (f = any(public.iv_answer_fields())) then warns := array_append(warns, ('Unknown answer-key column ignored: ' || k));
        elsif public.iv_parse_value(f, r->>k) is not null then ak := ak || jsonb_build_object(f, public.iv_parse_value(f, r->>k)); end if;
      end if;
    end loop;

    if cardinality(errs) > 0 then
      rejected := rejected + 1;
      results := results || jsonb_build_object('row', i, 'status', 'rejected', 'errors', to_jsonb(errs), 'warnings', to_jsonb(warns));
      continue;
    end if;

    accepted := accepted + 1;
    if not p_dry_run then
      select array(select jsonb_array_elements_text(profile_codes->v_profile)) into v_codes;
      insert into public.verifications (
        practice_id, provider_id, stedi_payer_id, payer_playbook_id, external_patient_id,
        patient_first_name, patient_last_name, patient_dob, member_id, group_number,
        is_dependent, subscriber, specialty_profile, service_codes, cpt_codes, date_of_service,
        appointment_at, payment_type, import_batch_id, status
      ) values (
        p_practice_id, v_provider.id, v_payer.stedi_payer_id, v_payer.id, nullif(trim(r->>'external_patient_id'), ''),
        trim(r->>'first_name'), trim(r->>'last_name'), v_dob, trim(r->>'member_id'), nullif(trim(r->>'group_number'), ''),
        v_sub_dob is not null,
        case when v_sub_dob is not null then jsonb_build_object('firstName', trim(r->>'subscriber_first_name'),
               'lastName', trim(r->>'subscriber_last_name'), 'dob', v_sub_dob::text) end,
        v_profile, v_codes, v_cpts, v_dos,
        case when v_dos is not null then v_dos::timestamptz end, 'insurance', batch_id, 'queued'
      ) returning id into v_vid;

      if ak <> '{}'::jsonb or coalesce(r->>'ak_how_obtained','') <> '' then
        insert into public.pilot_answer_keys (verification_id, practice_id, answers, how_obtained, minutes_spent)
        values (v_vid, p_practice_id, ak, nullif(trim(r->>'ak_how_obtained'), ''),
                case when coalesce(r->>'ak_minutes','') ~ '^\d+(\.\d+)?$' then (r->>'ak_minutes')::numeric end);
      end if;
    end if;
    results := results || jsonb_build_object('row', i, 'status', 'accepted', 'verification_id', v_vid,
                                             'errors', '[]'::jsonb, 'warnings', to_jsonb(warns),
                                             'answer_key_fields', (select count(*) from jsonb_object_keys(ak)));
  end loop;

  if not p_dry_run then
    update public.import_batches set accepted_count = accepted, rejected_count = rejected, skipped_count = skipped where id = batch_id;
  end if;

  return jsonb_build_object('batch_id', batch_id, 'dry_run', p_dry_run, 'total', i,
                            'accepted', accepted, 'rejected', rejected, 'skipped', skipped, 'rows', results);
end $$;

revoke all on function public.import_verifications(uuid, jsonb, text, jsonb, text, boolean) from public, anon;
grant execute on function public.import_verifications(uuid, jsonb, text, jsonb, text, boolean) to authenticated;
grant execute on function public.am_i_platform_admin() to authenticated;

-- ───────────────────────── staff answers: allow the new optional fields ─────────────────────────
create or replace function public.submit_human_fields(
  p_verification_id uuid, p_fields jsonb, p_note text default null
) returns public.verifications
language plpgsql security definer set search_path = public as $$
declare
  v public.verifications; k text; remaining text[];
  allowed text[] := public.iv_required_fields() || (public.iv_optional_fields());
begin
  select * into v from public.verifications where id = p_verification_id;
  if not found or not public.is_practice_member(v.practice_id) then
    raise exception 'Verification not found' using errcode = '42501';
  end if;
  if jsonb_typeof(p_fields) <> 'object' then raise exception 'p_fields must be a JSON object'; end if;
  for k in select jsonb_object_keys(p_fields) loop
    if not (k = any(allowed)) then raise exception 'Unknown field: %', k; end if;
    if p_fields->k is null or p_fields->k = 'null'::jsonb or p_fields->>k = '' then continue; end if;
    insert into public.verification_fields (verification_id, field_key, value, source, evidence, updated_at)
    values (v.id, k, p_fields->k, 'human',
            coalesce(nullif(trim(p_note), ''), 'Entered by staff') || ' (' || coalesce(auth.jwt()->>'email', 'staff') || ')', now())
    on conflict (verification_id, field_key) do update
      set value = excluded.value, source = 'human', evidence = excluded.evidence, attempt_id = null, updated_at = now();
  end loop;
  select coalesce(array_agg(f), '{}') into remaining
  from unnest(public.iv_required_fields()) f
  where not exists (select 1 from public.verification_fields vf where vf.verification_id = v.id and vf.field_key = f);
  insert into public.verification_attempts (verification_id, stage, status, gaps_in, gaps_out, finished_at)
  values (v.id, 'human', case when cardinality(remaining) = 0 then 'succeeded' else 'partial' end, v.open_gaps, remaining, now());
  update public.verifications set
    open_gaps = remaining,
    status = case when cardinality(remaining) = 0 then 'complete' else v.status end,
    current_stage = case when cardinality(remaining) = 0 then 'human' else v.current_stage end,
    completed_at = case when cardinality(remaining) = 0 then now() else null end,
    summary = coalesce(v.summary, '{}'::jsonb) || jsonb_build_object('note',
      'Staff entered ' || (select count(*) from jsonb_object_keys(p_fields)) || ' field(s)'
      || case when cardinality(remaining) = 0 then '. Verification complete.' else '. Still missing: ' || array_to_string(remaining, ', ') end)
  where id = v.id returning * into v;
  return v;
end $$;

-- ───────────────────────── derived fields + accuracy views ─────────────────────────
-- Engine values per verification, plus derived benefit_type / deductible_met / visits_remaining.
create or replace view public.verification_values with (security_invoker = true) as
with f as (
  select verification_id, jsonb_object_agg(field_key, value) as vals,
         jsonb_object_agg(field_key, source) as sources
  from public.verification_fields group by verification_id
)
select v.id as verification_id, v.practice_id,
  f.vals
  || jsonb_strip_nulls(jsonb_build_object(
       'benefit_type', case
          when (f.vals->>'coinsurance') ~ '^[\d.]+$' and (f.vals->>'coinsurance')::numeric > 0 then 'coinsurance'
          when (f.vals->>'copay') ~ '^[\d.]+$' and (f.vals->>'copay')::numeric > 0 then 'copay' end,
       'deductible_met', case when (f.vals->>'deductible_total') ~ '^[\d.]+$' and (f.vals->>'deductible_remaining') ~ '^[\d.]+$'
          then (f.vals->>'deductible_total')::numeric - (f.vals->>'deductible_remaining')::numeric end,
       'visits_remaining', case when (f.vals->>'visit_limit') ~ '^[\d.]+$' and (f.vals->>'visits_used') ~ '^[\d.]+$'
          then (f.vals->>'visit_limit')::numeric - (f.vals->>'visits_used')::numeric end
     )) as vals,
  f.sources
from public.verifications v
join f on f.verification_id = v.id;

create or replace function public.iv_values_match(ours jsonb, theirs jsonb)
returns boolean language sql immutable as $$
  select case
    when theirs is null then null
    when ours is null then false
    when jsonb_typeof(theirs) = 'number' and (ours #>> '{}') ~ '^-?[\d.]+$' then (ours #>> '{}')::numeric = (theirs #>> '{}')::numeric
    when jsonb_typeof(theirs) = 'boolean' then lower(ours #>> '{}') = lower(theirs #>> '{}')
    else lower(trim(ours #>> '{}')) = lower(trim(theirs #>> '{}'))
  end
$$;

-- One row per verification × answer-key field.
create or replace view public.pilot_comparison with (security_invoker = true) as
select ak.verification_id, ak.practice_id, v.import_batch_id, v.stedi_payer_id, p.name as payer_name,
       v.patient_last_name, v.status,
       kv.key as field_key,
       vv.vals -> kv.key as ours,
       kv.value as theirs,
       vv.sources ->> kv.key as our_source,
       public.iv_values_match(vv.vals -> kv.key, kv.value) as matched
from public.pilot_answer_keys ak
join public.verifications v on v.id = ak.verification_id
left join public.payer_playbooks p on p.stedi_payer_id = v.stedi_payer_id
left join public.verification_values vv on vv.verification_id = ak.verification_id
cross join lateral jsonb_each(ak.answers) kv;

-- Match rate per field (and per payer) for finished verifications.
create or replace view public.pilot_accuracy with (security_invoker = true) as
select practice_id, import_batch_id, payer_name, field_key,
       count(*) as compared,
       count(*) filter (where matched) as matched,
       count(*) filter (where ours is null) as we_missed,
       round(100.0 * count(*) filter (where matched) / nullif(count(*), 0), 1) as match_pct
from public.pilot_comparison
where status not in ('queued','running')
group by practice_id, import_batch_id, payer_name, field_key;

grant select on public.verification_values, public.pilot_comparison, public.pilot_accuracy to authenticated;
