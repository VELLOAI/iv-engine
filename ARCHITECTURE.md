# Insurance Verification Engine — Architecture v0.1

**Goal:** a completed benefits verification in the chart before every visit, with no staff time.

**The engine is a waterfall.** Every verification starts at the cheapest, fastest source. It moves to the next stage only for the fields still missing.

```
 intake (card captured / appointment booked)
        │
        ▼
 ┌─────────────┐  complete ─────────────────────────────┐
 │ 1. STEDI    │  ~1–3 s, cents per check                  │
 │  270 / 271  │  retryable payer error → retry ≤ 2 min    │
 └─────┬───────┘  bad patient data → back to practice      │
       │ gaps                                              │
       ▼                                                   │
 ┌──────────────────┐  complete ───────────────────────────┤
 │ 2. BROWSERBASE   │  payer portal / Availity, per-payer   │
 │  portal scrape   │  playbook; only the gap fields        │
 └─────┬────────────┘                                      │
       │ gaps still open (or no portal playbook)           │
       ▼                                                   │
 ┌──────────────────┐  complete ───────────────────────────┤
 │ 3. RETELL        │  calls payer IVR / rep, asks only the │
 │  voice agent     │  gap questions, returns JSON          │
 └─────┬────────────┘                                      │
       │ still open                                        │
       ▼                                                   ▼
 ┌──────────────────┐                          ┌──────────────────────┐
 │ 4. HUMAN QUEUE   │ ───────────────────────► │ RESULT → chart / UI  │
 │ practice staff   │                          │ plain-language summary│
 └──────────────────┘                          └──────────────────────┘
```

## Core design rules
1. **Field-level provenance.** Every benefit field records which stage filled it (`stedi`, `browserbase`, `retell`, `human`). This gives the UI "verified via portal," gives the business data on what each stage is worth per payer, and lets later stages ask only for what is missing.
2. **Each stage receives a gap list, not a patient file.** Browserbase and Retell get only the fields still missing, plus the minimum identifiers needed to look them up. That keeps prompts short, calls short and PHI exposure low.
3. **Payer playbooks drive routing.** The `payer_playbooks` table holds, per payer: whether a portal automation exists, portal type (Availity or the payer's own), phone number, IVR path, and which fields Stedi reliably leaves out. The router reads this table; the routing logic is not hard-coded.
4. **Errors are classified before escalating.** Not every Stedi failure is a gap:

| Stedi result | Meaning | Route |
|---|---|---|
| AAA 42 or HTTP 429/5xx | Payer or connection down | Retry Stedi with backoff for up to ~2 min, then Browserbase |
| AAA 72, 73, 75, 79 | Patient data wrong (member ID, name, not found) or wrong payer ID (79) | **Practice** fixes the card data. Escalating won't help: a portal or phone call needs the same data. |
| AAA 41, 43, or a "register NPI" message | Provider not enrolled or credentialed with the payer | Enrollment queue. This is a credentialing upsell signal. |
| Active coverage, required fields missing | Real gap | Browserbase if a portal playbook exists, else Retell |
| Inactive coverage | Definitive answer | Complete: notify the practice right away |

## What counts as "complete"
Defined per **specialty profile**, because a chiro visit and a therapy session need different fields:

| Field | Why the practice cares |
|---|---|
| Coverage active, plan name, group, plan dates | Can we see them at all |
| Network status for the service | In or out of network pricing |
| Copay for the service type | What to collect at the desk |
| Coinsurance for the service type | Patient share after deductible |
| Deductible: total and remaining | Whether they pay full price for now |
| Out-of-pocket max: total and remaining | Ceiling on patient cost |
| Visit limit and visits used | Chiro, PT and therapy caps (the most common gap) |
| Prior auth required | Whether claims will be denied without one |
| Carve-out vendor | Behavioral health or chiro managed by another company (e.g., ASH, Optum BH) |

Service type codes (STCs) by profile, as a starting set (validate against real responses):
- `chiro` → 33 (Chiropractic)
- `physical_therapy` → PT
- `behavioral_health` → MH (Mental Health). Also try A6/A7/A8 (psychotherapy / psychiatric, inpatient / outpatient variants) if a payer doesn't answer MH.
- `office_visit_specialist` → 96 / 98

## Stage contracts
Every stage implements the same interface, so stages can be added or reordered:

```
input:  { verificationId, payer, patientIdentifiers, providerNpi, gaps: [fieldKey...] }
output: { filled: { fieldKey: { value, source, evidence } }, stillMissing: [...], cost, rawRef }
```

- **Stedi:** `engine/stedi-client.mjs` + `engine/normalize.mjs` (built).
- **Browserbase:** one script per portal type (Availity first, since it covers most payers), driven by playbook selectors. Writes a screenshot of the benefits page as evidence.
- **Retell:** outbound call agent. Dynamic variables: payer phone, IVR path, NPI/tax ID, member ID, DOB, gap questions. Post-call analysis returns the gap fields as structured JSON. This fits the existing VELLO pattern: Supabase Edge Function → Retell outbound → webhook back.
- **Human:** a task in the practice's queue, shown in the UI, listing only the open fields.

## Build order
1. ✅ Stedi stage + normalizer + gap detector (test mode).
2. Supabase schema (this package) → Edge Function `verify` that runs stage 1 and writes results.
3. Seth/Ryan sessions: record which fields they still call or log in for, per payer, and turn that into `payer_playbooks` rows.
4. Retell gap-call agent for the top 3–5 payers' phone lines. Voice is likely faster to production than portal scraping, since it reuses VELLO tooling.
5. Browserbase on Availity for the same payers.
6. Lovable UI: verification list, result card, human queue, practice settings.

## Open questions to verify
- Exact key name for visit limits in the new 271 JSON shape. The normalizer checks any benefit key matching `limitation`. Confirm with a real chiro/PT response.
- Stedi reseller / multi-NPI terms and per-practice usage tagging (sales call).
- BAAs: Stedi (yes), Browserbase, Retell, Supabase (HIPAA add-on), the LLM. Confirm each before real PHI.
- Payer rules on automated portal access and AI callers.
