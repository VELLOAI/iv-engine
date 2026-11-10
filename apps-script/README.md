# apps-script/

Google Apps Script source. `clasp push` uploads this folder, and the GitHub Action does it automatically on push to `main`.

| File | Purpose |
|---|---|
| `Config.js` | Script Property access, timing constants, stage on/off switches |
| `Stedi.js` | Stedi 270/271 request builder + client (UrlFetchApp, retries for payer outages) |
| `Normalize.js` | 271 → fields per specialty profile, gap list, outcome (same logic as `engine/normalize.mjs`) |
| `Router.js` | Next stage: stedi → browserbase → retell → human |
| `Supabase.js` | PostgREST helpers using the service role / secret key |
| `Queue.js` | `processQueue` (every-minute trigger): claim queued checks → Stedi → write attempt, fields, status |
| `Browserbase.js` | Stage 2: invoke the `iv-portal-benefits` Function, poll it, write `browserbase` fields, route onward |
| `Webhook.js` | `doGet` health check; `doPost` Retell `call_analyzed` receiver (`?secret=WEBHOOK_SECRET`) |
| `Notify.js` | Clinic emails via Resend (5-min trigger `runNotifications`): daily recap at each clinic's set hour, "needs your attention" alerts (max every 3h, 8 AM–6 PM local), admin test sends. Counts and insurer names only, no patient identifiers |
| `Tests.js` | In-editor tests: `testConfig`, `testStediMock`, `seedMockVerification`, `testRetellWebhook`, `previewRecapEmail` |

**Script Properties (required):** `STEDI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET`
**Email (migration 008):** `RESEND_API_KEY`, `NOTIFY_FROM` (e.g. `ClearCover <reports@yourdomain.com>`, domain verified in Resend), `APP_URL`. Then run `installNotificationTrigger` once. `previewRecapEmail` logs what each clinic would get.
**Optional switches:** `BROWSERBASE_ENABLED=true` (+ `BROWSERBASE_API_KEY`, `BROWSERBASE_FUNCTION_ID`), `RETELL_ENABLED=true` (Retell dispatch not built yet; gaps go to staff). Until these are set, gaps go to the human queue (`needs_human`).

## First run (in the editor)
1. `testConfig`: confirms properties and Supabase access (approve permissions the first time).
2. `testStediMock`: Stedi mock UHC chiro check; no database writes.
3. `seedMockVerification`: queues a mock verification for your first provider.
4. `processQueue`: runs it. Check `verifications`, `verification_fields` and `verification_attempts` in Supabase.

Expected for the mock: status `needs_human`; gaps `deductible_total, visit_limit, prior_auth_required`; copay $15 and out-of-pocket $1,500 (with $850 remaining) filled from Stedi.
