# apps-script/

Google Apps Script source. `clasp push` uploads this folder, and the GitHub Action does it automatically on push to `main`.

Coming next: an Apps Script version of `engine/` (Stedi call, normalizer, router), the `processQueue` every-minute trigger, Supabase REST writes, and the Retell webhook `doPost`.
Secrets go in **Script Properties**, never in this repo: `STEDI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET`.
