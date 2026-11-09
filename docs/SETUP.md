# IV Engine — Setup Runbook (GitHub → Apps Script, Supabase, Lovable)

A new Supabase project just for insurance verification. All code lives in GitHub. The engine logic runs in Google Apps Script, deployed from GitHub. Lovable builds the UI on top of the Supabase data.

## How the pieces connect
```
Lovable UI ──(Supabase Auth + RLS)──► Supabase  ◄──(service role, REST)── Apps Script engine
  practice staff create / view                          ▲  1-min trigger: pick up queued checks
  verifications                                         │  Stedi → (gaps) → Retell / human
                                                        │
GitHub repo `iv-engine` ──(GitHub Action: clasp push)──►┘  Apps Script code
GitHub repo `iv-app` ◄──(Lovable two-way sync)── Lovable
Retell ──(webhook, follows 302)──► Apps Script web app doPost
```

## Step 0. Accounts
- GitHub: this repo (engine + schema). Lovable gets a second repo, `iv-app`, for the UI, so it never overwrites engine code.
- Google: use a **paid Google Workspace account with the HIPAA BAA accepted**, not a personal Gmail. Apps Script is on Google's covered-services list, but only under a signed Workspace BAA. Accept it in Admin console → Account → Legal and compliance.
- Supabase: new project. For real PHI, the HIPAA add-on (Team plan) plus a BAA are required. Mock data is fine without them.
- Node 18+ on your computer (for clasp and the Supabase CLI).

## Step 1. Supabase project
1. supabase.com → New project. Name `iv-engine`, region US East, strong DB password (save it in a password manager).
2. Project Settings → API: copy **Project URL**, **anon key** (for Lovable), **service_role key** (Apps Script only; never put it in Lovable or GitHub).
3. SQL Editor → paste `supabase/migrations/001_iv_engine.sql` → Run.
   Optional, to apply schema changes from this repo: `npm i -g supabase` → `supabase login` → `supabase link --project-ref <ref>` → `supabase db push`.
4. Authentication → create your user → in SQL: insert one row in `practices`, one in `practice_members` (your user id, role `owner`), one in `providers` (NPI `1999999984` for mock tests).
5. Database → Extensions: enable `pg_cron` (for the raw-271 purge job at the bottom of the migration).

## Step 2. Apps Script project, created from this repo with clasp
1. Turn on the Apps Script API: script.google.com/home/usersettings → **Google Apps Script API: On**.
2. `npm i -g @google/clasp` → `clasp login` (log in with the Workspace account).
3. Create the project at script.google.com → New project → rename it "IV Engine". Copy the Script ID (Project Settings).
4. At the repo root, create `.clasp.json` containing `{"scriptId":"<SCRIPT_ID>","rootDir":"apps-script"}`. The ID isn't secret, so commit it. Then run `clasp push -f`.
5. Apps Script editor → Project Settings → **Script Properties**: `STEDI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEBHOOK_SECRET` (a random string Retell sends as a query param, because Apps Script web apps can't read custom headers).
6. In the editor, run `testConfig`, `testStediMock`, `seedMockVerification`, then `processQueue` (see `apps-script/README.md`). The first run asks for permissions.
7. Triggers → **time-driven, every 1 minute** → `processQueue`. It picks up `queued` verifications. Polling avoids the 302 redirect that Supabase database webhooks would hit.
8. Deploy → New deployment → Web app → Execute as: me; Access: anyone. The URL plus `?secret=…` is the Retell webhook.

## Step 3. Auto-deploy from GitHub
1. `cat ~/.clasprc.json` → this repo → Settings → Secrets and variables → Actions → secret **`CLASPRC_JSON`** (paste the whole file).
2. Secret **`APPS_SCRIPT_DEPLOYMENT_ID`**: from Apps Script → Deploy → Manage deployments.
3. `.github/workflows/deploy-apps-script.yml` runs on push to `main` when `apps-script/` changes: `clasp push`, then updates the web app deployment.
4. GitHub is the source of truth. Use the Apps Script editor for testing only.

## Step 4. Lovable on top of Supabase
1. Lovable → new project → **Connect Supabase** → pick the existing `iv-engine` project. Don't let it create a new Lovable Cloud database.
2. Lovable → GitHub → create repo `iv-app`.
3. First prompt (also save it in Project Knowledge): *"The database schema is owned by an external repo. Do not create, alter, or drop tables, policies, or functions. Read from `verifications`, `verification_fields`, `verification_attempts`, `providers`, `payer_playbooks`. The only writes are inserting into `verifications` (status 'queued') and inserting `verification_fields` with source='human'. Use Supabase Auth; RLS already scopes data to the user's practice."*
4. v1 screens: login, verification list (status chips), new-verification form, result card (fields + source badges + plain-language summary), human queue (open gaps), payer playbook admin.

## Step 5. End-to-end test with mock data
1. In Lovable, create a verification for Stedi's mock patient: Jane Doe, DOB 1971-01-01, member `UHC123456`, payer `87726`, chiro.
2. Within about 1 minute, Apps Script runs Stedi. The row moves to `running` with next stage `retell` and gaps `deductible_total, visit_limit, prior_auth_required`.
3. Check `verification_attempts` and `verification_fields` in Supabase, and the result card in Lovable.

## Constraints to design around
- **Browserbase can't run inside Apps Script.** Driving a browser needs a runtime that holds a live connection, which Apps Script can't do. Run that one stage in a small Supabase Edge Function or a Browserbase-hosted function, called by Apps Script.
- **Apps Script limits:** 6 minutes max per run (process the queue with a time budget of about 4.5 min). No `fetch` or imports, so `engine/` gets ported to `UrlFetchApp`.
- **302 redirect:** Apps Script web apps redirect POSTs. Retell follows the redirect; curl doesn't. Test with in-editor functions.
- **Secrets:** the service_role and Stedi keys live only in Script Properties. The anon key is the only key Lovable gets.
