-- Insurance Verification Engine — schema v0.1
-- Multi-tenant from day one: every row hangs off a practice, and RLS limits
-- users to practices they belong to (practice_members).
-- Engine writes (Edge Functions) use the service role, which bypasses RLS.
--
-- _meta:
--   PHI: verifications.patient_* and verification_attempts.raw hold PHI.
--        Requires the Supabase HIPAA add-on + BAA before real patient data.
--   Retention: raw 271 payloads should be purged on a schedule (see bottom).

create extension if not exists pgcrypto;

-- ───────────────────────── tenancy ─────────────────────────
create table public.practices (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  specialty_profile  text not null default 'chiro'
                     check (specialty_profile in ('chiro','physical_therapy','behavioral_health','office_visit_specialist')),
  timezone           text not null default 'America/New_York',
  stedi_usage_tag    text,              -- per-practice usage reporting (confirm format with Stedi)
  created_at         timestamptz not null default now()
);

create table public.practice_members (
  practice_id  uuid not null references public.practices(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'staff' check (role in ('owner','staff')),
  created_at   timestamptz not null default now(),
  primary key (practice_id, user_id)
);

create table public.providers (
  id            uuid primary key default gen_random_uuid(),
  practice_id   uuid not null references public.practices(id) on delete cascade,
  npi           text not null check (npi ~ '^\d{10}$'),
  name          text not null,          -- sent to Stedi as provider.name.organization
  tax_id        text,                   -- payers often ask for it on phone/portal
  created_at    timestamptz not null default now(),
  unique (practice_id, npi)
);

-- ───────────────────────── payer playbooks ─────────────────────────
-- Global (not per practice): how to fill gaps for each payer.
create table public.payer_playbooks (
  id                         uuid primary key default gen_random_uuid(),
  stedi_payer_id             text not null unique,   -- e.g. 87726 UHC, 60054 Aetna, 62308 Cigna
  name                       text not null,
  portal_type                text check (portal_type in ('availity','payer_portal','none')),
  portal_automation_enabled  boolean not null default false,
  phone_number               text,
  ivr_path                   jsonb,                  -- ordered steps for the voice agent
  voice_automation_enabled   boolean not null default false,
  known_gap_fields           text[] not null default '{}',  -- fields Stedi reliably misses for this payer
  carve_outs                 jsonb,                  -- e.g. {"behavioral_health":"Optum BH","chiro":"ASH"}
  notes                      text,
  updated_at                 timestamptz not null default now()
);

-- ───────────────────────── verifications ─────────────────────────
create table public.verifications (
  id                  uuid primary key default gen_random_uuid(),
  practice_id         uuid not null references public.practices(id) on delete cascade,
  provider_id         uuid not null references public.providers(id),
  stedi_payer_id      text not null,
  payer_playbook_id   uuid references public.payer_playbooks(id),
  external_patient_id text,                -- EHR patient id, for write-back
  patient_first_name  text not null,
  patient_last_name   text not null,
  patient_dob         date not null,
  member_id           text,
  is_dependent        boolean not null default false,
  subscriber          jsonb,               -- subscriber identity when the patient is a dependent
  specialty_profile   text not null,
  service_codes       text[] not null,     -- STCs requested, e.g. {'33'}
  appointment_at      timestamptz,
  status              text not null default 'queued'
                      check (status in ('queued','running','complete','inactive_coverage',
                                        'needs_practice_data','needs_enrollment','needs_human','failed')),
  current_stage       text check (current_stage in ('stedi','browserbase','retell','human')),
  open_gaps           text[] not null default '{}',
  summary             jsonb,               -- plain-language result for UI / chart write-back
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index verifications_practice_status_idx on public.verifications (practice_id, status);
create index verifications_appointment_idx     on public.verifications (practice_id, appointment_at);

-- One row per stage run. Retries create new rows.
create table public.verification_attempts (
  id               uuid primary key default gen_random_uuid(),
  verification_id  uuid not null references public.verifications(id) on delete cascade,
  stage            text not null check (stage in ('stedi','browserbase','retell','human')),
  status           text not null check (status in ('running','succeeded','partial','retryable_error','data_error','enrollment_error','failed')),
  gaps_in          text[] not null default '{}',
  gaps_out         text[] not null default '{}',
  error_codes      text[] not null default '{}',   -- AAA codes, HTTP status, portal/IVR errors
  external_ref     text,                           -- Stedi check id / Browserbase session / Retell call id
  cost_cents       numeric(10,2),
  raw              jsonb,                          -- PHI: purge on schedule
  started_at       timestamptz not null default now(),
  finished_at      timestamptz
);
create index verification_attempts_verification_idx on public.verification_attempts (verification_id, started_at);

-- Field-level results with provenance. One current value per field.
create table public.verification_fields (
  verification_id  uuid not null references public.verifications(id) on delete cascade,
  field_key        text not null,       -- see engine/normalize.mjs FIELD_KEYS
  value            jsonb,
  source           text not null check (source in ('stedi','browserbase','retell','human')),
  attempt_id       uuid references public.verification_attempts(id),
  evidence         text,                -- Stedi message, screenshot path, call transcript excerpt
  updated_at       timestamptz not null default now(),
  primary key (verification_id, field_key)
);

-- ───────────────────────── RLS ─────────────────────────
create or replace function public.is_practice_member(p_practice uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.practice_members
                 where practice_id = p_practice and user_id = auth.uid());
$$;

alter table public.practices             enable row level security;
alter table public.practice_members      enable row level security;
alter table public.providers             enable row level security;
alter table public.payer_playbooks       enable row level security;
alter table public.verifications         enable row level security;
alter table public.verification_attempts enable row level security;
alter table public.verification_fields   enable row level security;

create policy practices_read on public.practices
  for select to authenticated using (public.is_practice_member(id));
create policy members_read on public.practice_members
  for select to authenticated using (public.is_practice_member(practice_id));
create policy providers_read on public.providers
  for select to authenticated using (public.is_practice_member(practice_id));
create policy playbooks_read on public.payer_playbooks
  for select to authenticated using (true);   -- no PHI, shared reference data
create policy verifications_read on public.verifications
  for select to authenticated using (public.is_practice_member(practice_id));
-- Practice staff can create verifications and resolve human-queue fields.
create policy verifications_insert on public.verifications
  for insert to authenticated with check (public.is_practice_member(practice_id));
create policy attempts_read on public.verification_attempts
  for select to authenticated using (exists (
    select 1 from public.verifications v
    where v.id = verification_id and public.is_practice_member(v.practice_id)));
create policy fields_read on public.verification_fields
  for select to authenticated using (exists (
    select 1 from public.verifications v
    where v.id = verification_id and public.is_practice_member(v.practice_id)));
create policy fields_human_write on public.verification_fields
  for insert to authenticated with check (source = 'human' and exists (
    select 1 from public.verifications v
    where v.id = verification_id and public.is_practice_member(v.practice_id)));

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger verifications_touch before update on public.verifications
  for each row execute function public.touch_updated_at();
create trigger playbooks_touch before update on public.payer_playbooks
  for each row execute function public.touch_updated_at();

-- ───────────────────────── seed: playbooks for Stedi test-mode payers ─────────────────────────
insert into public.payer_playbooks (stedi_payer_id, name, portal_type) values
  ('87726', 'UnitedHealthcare', 'payer_portal'),
  ('60054', 'Aetna',            'availity'),
  ('62308', 'Cigna',            'payer_portal'),
  ('61101', 'Humana',           'availity')
on conflict (stedi_payer_id) do nothing;

-- ───────────────────────── retention (enable once pg_cron is on) ─────────────────────────
-- select cron.schedule('purge-raw-271', '17 3 * * *',
--   $$update public.verification_attempts set raw = null
--     where raw is not null and finished_at < now() - interval '30 days'$$);
