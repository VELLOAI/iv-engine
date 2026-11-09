-- IV Engine — 002: Browserbase portal stage
-- Adds a 'mock' portal type (the mock portal in /browserbase) and turns the portal stage
-- on for the UHC demo payer, so the Stedi → Browserbase → staff waterfall can be tested
-- end to end with Stedi's mock patient (Jane Doe, UHC123456).
--
-- _meta: when a real portal adapter exists, set that payer back to portal_type 'availity'
--        (or 'payer_portal'). Mock data only; no PHI.

alter table public.payer_playbooks drop constraint if exists payer_playbooks_portal_type_check;
alter table public.payer_playbooks add constraint payer_playbooks_portal_type_check
  check (portal_type in ('availity', 'payer_portal', 'mock', 'none'));

update public.payer_playbooks
   set portal_type = 'mock',
       portal_automation_enabled = true,
       notes = case when coalesce(notes, '') like '%Demo: mock portal%' then notes
                    else coalesce(notes || E'\n', '') || 'Demo: mock portal (Browserbase stage test). Switch to availity when the real adapter is built.' end
 where stedi_payer_id = '87726';
