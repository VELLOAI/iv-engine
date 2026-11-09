#!/usr/bin/env node
// Runs Stedi's predefined test-mode mock checks through the full stage-1 pipeline:
//   request → Stedi → normalize → gap list → routing decision
//
// Usage:
//   STEDI_API_KEY=<test key> node scripts/stedi-mock-test.mjs
//   node scripts/stedi-mock-test.mjs --profile behavioral_health
//   node scripts/stedi-mock-test.mjs --only uhc-active,aaa-75 --save responses/
//   node scripts/stedi-mock-test.mjs --offline responses/        (no API calls; replays saved responses)
//   node scripts/stedi-mock-test.mjs --json                      (machine-readable output)
//
// _meta:
//   Mock values below are Stedi's published test-mode requests. Test mode rejects any other
//   name / DOB / member ID. If a scenario starts erroring, re-copy its values from
//   Stedi docs → "Eligibility mock requests".

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildEligibilityRequest, checkEligibility } from '../engine/stedi-client.mjs';
import { normalizeStediResponse, plainSummary, PROFILE_STCS } from '../engine/normalize.mjs';
import { route } from '../engine/router.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? true : arr[i + 1]]);
  return acc;
}, []));
const profile = args.profile ?? 'chiro';
if (!PROFILE_STCS[profile]) { console.error(`Unknown profile. Use: ${Object.keys(PROFILE_STCS).join(', ')}`); process.exit(1); }

const OK_PROVIDER = { providerName: 'Demo Clinic', npi: '1999999984' };
const ERR_PROVIDER = { providerName: 'Medical Provider', npi: '1999999984' }; // error mocks expect this name
const S = (name, payerId, firstName, lastName, memberId, dob, provider = OK_PROVIDER) =>
  ({ name, req: { payerId, firstName, lastName, memberId, dob, ...provider } });

const SCENARIOS = [
  S('uhc-active',    '87726', 'Jane',  'Doe',   'UHC123456',   '1971-01-01'),
  S('uhc-inactive',  '87726', 'Jane',  'Doe',   'UHCINACTIVE', '1971-01-01'),
  S('cigna-active',  '62308', 'James', 'Jones', '23456789100', '1991-02-02'),
  S('aetna-active',  '60054', 'Jane',  'Doe',   'AETNA12345',  '2004-04-04'),
  S('humana-active', '61101', 'Jane',  'Doe',   'HUMANA123',   '1975-05-05'),
  S('aaa-42',        '87726', 'Jane',  'Doe',   'UHCAAA42',    '2001-01-01', ERR_PROVIDER),
  S('aaa-43',        '87726', 'Jane',  'Doe',   'UHCAAA43',    '1970-01-01', ERR_PROVIDER),
  S('aaa-72',        '87726', 'John',  'Doe',   'UHCAAA72',    '1990-01-01', ERR_PROVIDER),
  S('aaa-73',        '87726', 'John',  'Doe',   'UHCAAA73',    '1990-01-01', ERR_PROVIDER),
  S('aaa-75',        '87726', 'Jane',  'Doe',   'UHCAAA75',    '1990-01-01', ERR_PROVIDER),
  S('aaa-79',        '87726', 'John',  'Doe',   'UHCAAA79',    '1970-01-01', ERR_PROVIDER),
];

// Simulated playbooks so routing shows the full waterfall. Real ones come from payer_playbooks.
const PLAYBOOKS = {
  '87726': { portal_automation_enabled: false, voice_automation_enabled: true, phone_number: '+1-877-842-3210' },
  '60054': { portal_automation_enabled: true,  voice_automation_enabled: true, phone_number: '+1-800-624-0756' },
};

const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const rows = [];

for (const s of SCENARIOS.filter((x) => !only || only.has(x.name))) {
  // Error mocks are defined with STC 30; benefit mocks get the profile's first STC.
  const stc = s.name.startsWith('aaa-') ? '30' : PROFILE_STCS[profile][0];
  const body = buildEligibilityRequest({ ...s.req, serviceCodes: [stc] });

  let resp;
  if (args.offline) {
    const p = join(args.offline, `${s.name}.json`);
    if (!existsSync(p)) { rows.push({ scenario: s.name, outcome: 'skipped (no saved response)' }); continue; }
    resp = JSON.parse(readFileSync(p, 'utf8'));
  } else {
    resp = await checkEligibility(body, { retryWindowMs: s.name === 'aaa-42' ? 5_000 : 120_000 });
    if (args.save) { mkdirSync(args.save, { recursive: true }); writeFileSync(join(args.save, `${s.name}.json`), JSON.stringify(resp, null, 2)); }
  }

  // Mocks may not answer the profile STC; fall back to whatever the payer returned for STC 30 + others.
  const n = normalizeStediResponse(resp, { profile });
  const r = route(n, PLAYBOOKS[s.req.payerId] ?? null, 'stedi');
  rows.push({
    scenario: s.name, http: resp.httpStatus, tries: resp.tries, outcome: n.outcome,
    next: r.nextStage ?? '—', status: r.status, gaps: n.gaps.join(', ') || '—',
    summary: plainSummary(n), fields: n.fields,
  });
}

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log(`\nProfile: ${profile} (STC ${PROFILE_STCS[profile].join('/')})\n`);
  for (const r of rows) {
    if (!r.status) { console.log(`■ ${r.scenario}  ${r.outcome}`); continue; }
    console.log(`■ ${r.scenario}  [HTTP ${r.http ?? '-'} · tries ${r.tries ?? '-'}]  ${r.outcome}  →  ${r.status}${r.next !== '—' ? ` / next: ${r.next}` : ''}`);
    if (r.summary) console.log(`   ${r.summary}`);
    if (r.gaps && r.gaps !== '—' && r.outcome === 'gaps') console.log(`   gaps: ${r.gaps}`);
  }
  const counts = rows.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] ?? 0) + 1), a), {});
  console.log(`\nTotals: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}\n`);
}
