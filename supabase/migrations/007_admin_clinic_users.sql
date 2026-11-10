-- IV Engine — 007: admin management of clinics, providers and clinic users
-- Platform admins (platform_admins) can create clinics (practices), add providers, and see /
-- change / remove who belongs to each clinic. Creating the login itself (email + password)
-- happens in the Edge Function `admin-users`, which needs the service role; it then adds the
-- membership row. Clinic users only ever see their own clinic (existing RLS).

-- Guard used by every admin RPC
create or replace function public.iv_require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.platform_admins where user_id = auth.uid()) then
    raise exception 'Admins only' using errcode = '42501';
  end if;
end $$;

-- ───────────── clinics ─────────────
create or replace function public.admin_create_practice(
  p_name text, p_specialty text default 'chiro', p_timezone text default 'America/New_York'
) returns public.practices
language plpgsql security definer set search_path = public as $$
declare v public.practices;
begin
  perform public.iv_require_admin();
  if coalesce(trim(p_name), '') = '' then raise exception 'Clinic name is required'; end if;
  insert into public.practices (name, specialty_profile, timezone)
  values (trim(p_name), coalesce(nullif(p_specialty, ''), 'chiro'), coalesce(nullif(p_timezone, ''), 'America/New_York'))
  returning * into v;
  return v;
end $$;

create or replace function public.admin_update_practice(
  p_practice_id uuid, p_name text default null, p_specialty text default null
) returns public.practices
language plpgsql security definer set search_path = public as $$
declare v public.practices;
begin
  perform public.iv_require_admin();
  update public.practices set
    name = coalesce(nullif(trim(p_name), ''), name),
    specialty_profile = coalesce(nullif(p_specialty, ''), specialty_profile)
  where id = p_practice_id returning * into v;
  if v.id is null then raise exception 'Clinic not found'; end if;
  return v;
end $$;

-- ───────────── providers ─────────────
-- NPI check digit (Luhn with the 80840 prefix), so typos are caught before Stedi rejects them.
create or replace function public.iv_npi_valid(p_npi text)
returns boolean language plpgsql immutable as $$
declare s text := '80840' || coalesce(p_npi, ''); total int := 0; d int; i int; dbl boolean := false;
begin
  if p_npi !~ '^\d{10}$' then return false; end if;
  for i in reverse length(s)..1 loop
    d := substr(s, i, 1)::int;
    if dbl then d := d * 2; if d > 9 then d := d - 9; end if; end if;
    total := total + d; dbl := not dbl;
  end loop;
  return total % 10 = 0;
end $$;

create or replace function public.admin_upsert_provider(
  p_practice_id uuid, p_npi text, p_name text, p_tax_id text default null
) returns public.providers
language plpgsql security definer set search_path = public as $$
declare v public.providers;
begin
  perform public.iv_require_admin();
  if not exists (select 1 from public.practices where id = p_practice_id) then raise exception 'Clinic not found'; end if;
  if not public.iv_npi_valid(trim(p_npi)) then raise exception 'NPI % is not a valid 10-digit NPI', p_npi; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Provider name is required'; end if;
  insert into public.providers (practice_id, npi, name, tax_id)
  values (p_practice_id, trim(p_npi), trim(p_name), nullif(trim(p_tax_id), ''))
  on conflict (practice_id, npi) do update set name = excluded.name, tax_id = coalesce(excluded.tax_id, public.providers.tax_id)
  returning * into v;
  return v;
end $$;

create or replace function public.admin_delete_provider(p_provider_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.iv_require_admin();
  if exists (select 1 from public.verifications where provider_id = p_provider_id) then
    raise exception 'This provider has verifications and can''t be deleted';
  end if;
  delete from public.providers where id = p_provider_id;
end $$;

-- ───────────── clinic users ─────────────
create or replace function public.admin_list_practice_users(p_practice_id uuid)
returns table (user_id uuid, email text, role text, added_at timestamptz, last_sign_in_at timestamptz, must_change_password boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  perform public.iv_require_admin();
  return query
    select m.user_id, u.email::text, m.role, m.created_at, u.last_sign_in_at,
           coalesce((u.raw_user_meta_data->>'must_change_password')::boolean, false)
    from public.practice_members m
    join auth.users u on u.id = m.user_id
    where m.practice_id = p_practice_id
    order by u.email;
end $$;

create or replace function public.admin_set_practice_role(p_practice_id uuid, p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.iv_require_admin();
  if p_role not in ('owner','staff') then raise exception 'Role must be owner or staff'; end if;
  update public.practice_members set role = p_role where practice_id = p_practice_id and user_id = p_user_id;
  if not found then raise exception 'User is not in this clinic'; end if;
end $$;

-- Removes clinic access only; the login itself is deleted by the Edge Function if requested.
create or replace function public.admin_remove_practice_user(p_practice_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.iv_require_admin();
  delete from public.practice_members where practice_id = p_practice_id and user_id = p_user_id;
end $$;

-- What the signed-in user can use the app for (drives the UI).
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = public, auth as $$
  select jsonb_build_object(
    'is_admin', exists (select 1 from public.platform_admins where user_id = auth.uid()),
    'must_change_password', coalesce((select (raw_user_meta_data->>'must_change_password')::boolean from auth.users where id = auth.uid()), false),
    'practices', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', m.role) order by p.name)
                           from public.practice_members m join public.practices p on p.id = m.practice_id
                           where m.user_id = auth.uid()), '[]'::jsonb)
  )
$$;

-- Lets a user clear their own "must change password" flag after setting a new password.
create or replace function public.mark_password_changed()
returns void language sql security definer set search_path = public, auth as $$
  update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'must_change_password'
  where id = auth.uid();
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'iv_require_admin()', 'admin_create_practice(text, text, text)', 'admin_update_practice(uuid, text, text)',
    'admin_upsert_provider(uuid, text, text, text)', 'admin_delete_provider(uuid)',
    'admin_list_practice_users(uuid)', 'admin_set_practice_role(uuid, uuid, text)',
    'admin_remove_practice_user(uuid, uuid)', 'my_access()', 'mark_password_changed()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
