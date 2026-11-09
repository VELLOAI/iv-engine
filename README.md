# IV Engine: stage 1 (Stedi)

The engine and decision-making layer for automated insurance verification. Verifications run Stedi → Browserbase → Retell → human. See `ARCHITECTURE.md`.

## What's here
| Path | What it does |
|---|---|
| `engine/stedi-client.mjs` | Calls Stedi's 2026-06-01 eligibility endpoint. Retries payer outages for up to 2 min. No dependencies. |
| `engine/normalize.mjs` | Converts the 271 response into fields for one specialty profile, each with evidence; builds the gap list; classifies errors. |
| `engine/router.mjs` | Decides the next stage from the outcome and the payer's playbook. |
| `scripts/stedi-mock-test.mjs` | Runs all of Stedi's test-mode mock checks through the full pipeline. |
| `supabase/migrations/001_iv_engine.sql` | Multi-tenant schema with RLS. Tracks which stage filled each field. |
| `apps-script/` | Apps Script source, auto-deployed by `.github/workflows/deploy-apps-script.yml` |
| `docs/SETUP.md` | Step-by-step setup: Supabase, Apps Script, GitHub deploys, Lovable |

## Run it against your Stedi account (5 min)
1. Stedi portal → account name → **API Keys** → Generate → Mode: **Test**.
2. Requires Node 18+:
   ```bash
   export STEDI_API_KEY=<your test key>
   node scripts/stedi-mock-test.mjs                         # chiro profile
   node scripts/stedi-mock-test.mjs --profile behavioral_health
   node scripts/stedi-mock-test.mjs --save responses/       # keep raw 271s
   node scripts/stedi-mock-test.mjs --offline responses/    # replay with no API calls
   ```
   Mock checks are free. A test key only accepts Stedi's predefined mock patients.

## Apply the schema
Supabase SQL editor → paste `001_iv_engine.sql` → run. Or use `supabase db push` from a repo.
Before any real patient data: turn on the Supabase HIPAA add-on, sign the BAA, and enable the retention cron at the bottom of the file.

## Field keys (the contract every stage shares)
Required: `coverage_active, plan_name, network_status, copay, coinsurance, deductible_total, deductible_remaining, oop_max_total, oop_remaining, visit_limit, prior_auth_required`
Optional: `group_number, plan_start, visits_used, carve_out_vendor, payer_messages`

The Browserbase and Retell stages receive a list of gap keys. They return `{ fieldKey: { value, source, evidence } }` for the keys they fill.

## Next build steps
1. Supabase Edge Function `verify`: insert a verification, run stage 1, write `verification_attempts` and `verification_fields`, set `status`, `current_stage` and `open_gaps`.
2. Retell gap-call agent: takes gap keys and the payer playbook's phone number and IVR path, and returns the same field JSON through post-call analysis.
3. Browserbase Availity script for the same gap keys.
4. Lovable UI on top of the `verifications` and `verification_fields` tables.
