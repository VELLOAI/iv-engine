-- IV Engine — 006: treat "Self Pay" / "Cash" / "None" in the insurance column as cash (skip),
-- so raw EHR exports don't send them to payer lookup. Same function as 005 otherwise.

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
  v_payer_raw text;
  v_provider public.providers;
  v_profile  text; v_codes text[]; v_cpts text[];
  v_member   text;
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
    v_payer := null; v_provider := null; v_vid := null; v_payer_raw := null;

    -- cash / self-pay: flagged in a payment-type column OR written in the insurance column
    if lower(coalesce(r->>'payment_type', '')) in ('cash','self-pay','self pay','selfpay','private pay')
       or lower(trim(coalesce(r->>'payer', ''))) in ('self pay','self-pay','selfpay','cash','private pay','none','no insurance','uninsured','n/a','na') then
      skipped := skipped + 1;
      results := results || jsonb_build_object('row', i, 'status', 'skipped', 'errors', '[]'::jsonb,
                                               'warnings', jsonb_build_array('Cash patient — no verification needed'));
      continue;
    end if;

    if coalesce(trim(r->>'first_name'), '') = '' then errs := array_append(errs, 'First name is missing'); end if;
    if coalesce(trim(r->>'last_name'), '') = ''  then errs := array_append(errs, 'Last name is missing'); end if;
    v_dob := public.iv_parse_date(r->>'dob');
    if v_dob is null then errs := array_append(errs, 'Date of birth is missing or not a date: "' || coalesce(r->>'dob','') || '" (use YYYY-MM-DD or MM/DD/YYYY)');
    elsif v_dob > current_date or v_dob < date '1900-01-01' then errs := array_append(errs, 'Date of birth is out of range'); end if;

    v_member := nullif(trim(coalesce(r->>'member_id', '')), '');
    if v_member is null then
      warns := array_append(warns, 'No member ID: many payers can''t find the patient without it');
    end if;

    -- payer: our playbook (ID / name / alias), else keep the raw name for the engine to resolve
    if coalesce(trim(r->>'payer'), '') = '' then
      errs := array_append(errs, 'Insurance company is missing');
    else
      select * into v_payer from public.payer_playbooks p
       where p.stedi_payer_id = trim(r->>'payer')
          or lower(p.name) = lower(trim(r->>'payer'))
          or exists (select 1 from unnest(p.aliases) a where lower(a) = lower(trim(r->>'payer')))
       limit 1;
      if v_payer.stedi_payer_id is null then
        v_payer_raw := trim(r->>'payer');
        warns := array_append(warns, 'Insurance "' || v_payer_raw || '" will be matched to a payer automatically');
      end if;
    end if;

    if coalesce(trim(r->>'provider_npi'), '') <> '' then
      select * into v_provider from public.providers where practice_id = p_practice_id and npi = trim(r->>'provider_npi');
      if v_provider.id is null then errs := array_append(errs, 'Provider NPI ' || trim(r->>'provider_npi') || ' is not set up for this practice'); end if;
    else
      if (select count(*) from public.providers where practice_id = p_practice_id) = 1 then
        select * into v_provider from public.providers where practice_id = p_practice_id;
      else errs := array_append(errs, 'Provider is missing: pick a provider for the file or map an NPI column'); end if;
    end if;

    v_profile := coalesce(nullif(lower(trim(r->>'specialty')), ''), practice.specialty_profile);
    v_profile := case when v_profile in ('chiro','chiropractic','dc') then 'chiro'
                      when v_profile in ('pt','physical_therapy','physical therapy') then 'physical_therapy'
                      when v_profile in ('bh','behavioral_health','behavioral health','mental health') then 'behavioral_health'
                      when v_profile in ('specialist','office_visit_specialist') then 'office_visit_specialist'
                      else null end;
    if v_profile is null then errs := array_append(errs, 'Specialty not recognized: "' || coalesce(r->>'specialty','') || '"'); end if;

    v_dos := null;
    if coalesce(trim(r->>'date_of_service'), '') <> '' then
      v_dos := public.iv_parse_date(r->>'date_of_service');
      if v_dos is null then warns := array_append(warns, 'Date of service not understood; left blank'); end if;
    end if;

    v_sub_dob := null;
    if coalesce(trim(r->>'subscriber_last_name'), '') <> '' then
      v_sub_dob := public.iv_parse_date(r->>'subscriber_dob');
      if v_sub_dob is null then errs := array_append(errs, 'Patient is a dependent but subscriber DOB is missing or not a date'); end if;
    end if;

    v_cpts := coalesce(array(select trim(x) from regexp_split_to_table(coalesce(r->>'cpt_codes', ''), '[,;\s]+') x where trim(x) <> ''), '{}');

    -- duplicates: member ID if present, else name; + DOB + date of service
    dedupe_key := lower(coalesce(v_member, trim(r->>'first_name') || ' ' || trim(r->>'last_name'), ''))
                  || '|' || coalesce(v_dob::text, '') || '|' || coalesce(v_dos::text, '');
    if dedupe_key = any(seen) then errs := array_append(errs, 'Duplicate of an earlier row in this file');
    elsif v_dob is not null and exists (
      select 1 from public.verifications x
       where x.practice_id = p_practice_id and x.patient_dob = v_dob
         and (case when v_member is not null then lower(x.member_id) = lower(v_member)
                   else lower(x.patient_first_name) = lower(trim(r->>'first_name')) and lower(x.patient_last_name) = lower(trim(r->>'last_name')) end)
         and coalesce(x.date_of_service, date '1900-01-01') = coalesce(v_dos, date '1900-01-01')
         and x.status in ('queued','running')) then
      errs := array_append(errs, 'Already being verified (same patient, DOB and date of service)');
    end if;
    seen := array_append(seen, dedupe_key);

    ak := '{}'::jsonb;
    for k in select jsonb_object_keys(r) loop
      if k like 'ak\_%' and k not in ('ak_how_obtained','ak_minutes') then
        f := substring(k from 4);
        if not (f = any(public.iv_answer_fields())) then warns := array_append(warns, 'Unknown answer-key column ignored: ' || k);
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
        practice_id, provider_id, stedi_payer_id, payer_playbook_id, payer_name_raw, external_patient_id,
        patient_first_name, patient_last_name, patient_dob, member_id, group_number, location,
        is_dependent, subscriber, specialty_profile, service_codes, cpt_codes, date_of_service,
        appointment_at, payment_type, import_batch_id, status
      ) values (
        p_practice_id, v_provider.id, v_payer.stedi_payer_id, v_payer.id, v_payer_raw, nullif(trim(r->>'external_patient_id'), ''),
        trim(r->>'first_name'), trim(r->>'last_name'), v_dob, v_member, nullif(trim(r->>'group_number'), ''), nullif(trim(r->>'location'), ''),
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
