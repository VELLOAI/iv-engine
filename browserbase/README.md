# browserbase/: IV engine stage 2 (payer portal)

A Browserbase Function (`iv-portal-benefits`) that logs into a payer portal, reads **only the fields Stedi didn't return**, and hands them back to Apps Script. Apps Script starts the function, checks back on each 1-minute run, writes the fields (`source = browserbase`), and routes any remaining gaps to Retell or staff.

- **Plain Playwright, no AI model:** patient data never goes to an LLM.
- **Session recording and logging are off:** portal screens show patient data.
- **Adapters:** `src/portals/mock.ts` works now. `src/portals/availity.ts` is waiting on a pilot login and a recorded walkthrough of the portal.

## Test locally (no Browserbase account needed)
```bash
cd browserbase
npm install
npm run test:local      # uses /Applications/Google Chrome.app; set CHROME_PATH to override
```
Expect: the mock portal fills `deductible_total` 1500, `visit_limit` 20 and `prior_auth_required` false for UHC123456; an unknown member returns `not_found`; Availity returns `not_implemented`.

## Publish to Browserbase
```bash
cd browserbase
export BROWSERBASE_API_KEY=bb_live_...      # Browserbase → Settings
npx bb publish index.ts
```
Copy the Function ID from the output (`builtFunctions[].id`). No Secrets are needed for the mock portal.

## Turn it on
1. Supabase SQL Editor: run `supabase/migrations/002_browserbase_stage.sql`. It adds the `mock` portal type and enables the portal for the UHC demo payer.
2. Apps Script → Script Properties:
   - `BROWSERBASE_API_KEY`: same key as above
   - `BROWSERBASE_FUNCTION_ID`: from publish
   - `BROWSERBASE_ENABLED`: `true`
3. Create a verification for Jane Doe / UHC123456 / chiro. Within about 1–3 minutes it should go **running (browserbase) → complete**, with three fields tagged `browserbase`.

## Before real patients
- Signed BAAs: Browserbase (enterprise), the pilot practice, and every other vendor that handles patient data.
- A dedicated portal user per practice, stored encrypted (Supabase Vault), never in this repo or in Script Properties.
- The real Availity adapter, built from a recorded walkthrough.
