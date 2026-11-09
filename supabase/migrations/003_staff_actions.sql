-- IV Engine — 003: staff actions for the Lovable UI
-- Two RPCs instead of a broad UPDATE policy, so staff can only do these two things:
--   retry_verification   → fix patient/payer data and send it back through the engine
--   submit_human_fields  → answer open gaps; completes the verification when none are left
-- Both check practice membership (RLS-equivalent) and run as SECURITY DEFINER.

-- Required fields (keep in sync with apps-script/Normalize.js FIELD_KEYS.required)
create or replace function public.iv_required_fields()
returns text[] language sql immutable as $$
  select array['coverage_active','plan_name','network_status','copay','coinsurance',
               'deductible_total','deductible_remaining','oop_max_total','oop_remaining',
               'visit_limit','prior_auth_required']::text[]
$$;

-- ───────────── retry_verification ─────────────
-- Pass only what changes; null keeps the current value.
create or replace function public.retry_verification(
  p_verification_id uuid,
  p_first_name text default null,
  p_last_name  text default null,
  p_dob        date default null,
  p_member_id  text default null,
  p_payer_id   text default null
) returns public.verifications
language plpgsql security definer set search_path = public as $$
declare v public.verifications;
begin
  select * into v from public.verifications where id = p_verification_id;
  if not found or not public.is_practice_member(v.practice_id) then
    raise exception 'Verification not found' using errcode = '42501';
  end if;
  if v.status not in ('needs_practice_data', 'needs_enrollment', 'needs_human', 'failed', 'inactive_coverage') then
    raise exception 'Only verifications that need attention can be retried (status is %)', v.status;
  end if;

  -- Old answers may belong to the wrong patient/payer: clear them. Attempts stay as history.
  delete from public.verification_fields where verification_id = v.id;

  update public.verifications set
    patient_first_name = coalesce(nullif(trim(p_first_name), ''), patient_first_name),
    patient_last_name  = coalesce(nullif(trim(p_last_name), ''),  patient_last_name),
    patient_dob        = coalesce(p_dob, patient_dob),
    member_id          = coalesce(nullif(trim(p_member_id), ''), member_id),
    stedi_payer_id     = coalesce(nullif(trim(p_payer_id), ''),  stedi_payer_id),
    status = 'queued', current_stage = null, open_gaps = '{}', completed_at = null,
    summary = jsonb_build_object('text', 'Re-queued by staff after correcting patient details.', 'outcome', 'queued')
  where id = v.id
  returning * into v;
  return v;
end $$;

-- ───────────── submit_human_fields ─────────────
-- p_fields: {"visit_limit": 20, "prior_auth_required": false, ...}
-- p_note:   where staff got it, e.g. "Called UHC, ref #12345"
create or replace function public.submit_human_fields(
  p_verification_id uuid,
  p_fields jsonb,
  p_note text default null
) returns public.verifications
language plpgsql security definer set search_path = public as $$
declare
  v public.verifications;
  k text;
  allowed text[] := public.iv_required_fields() || array['group_number','plan_start','visits_used','carve_out_vendor'];
  remaining text[];
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
    summary = coalesce(v.summary, '{}'::jsonb) || jsonb_build_object(
      'note', 'Staff entered ' || (select count(*) from jsonb_object_keys(p_fields)) || ' field(s)'
              || case when cardinality(remaining) = 0 then '. Verification complete.' else '. Still missing: ' || array_to_string(remaining, ', ') end)
  where id = v.id
  returning * into v;
  return v;
end $$;

revoke all on function public.retry_verification(uuid, text, text, date, text, text) from public, anon;
revoke all on function public.submit_human_fields(uuid, jsonb, text) from public, anon;
grant execute on function public.retry_verification(uuid, text, text, date, text, text) to authenticated;
grant execute on function public.submit_human_fields(uuid, jsonb, text) to authenticated;
