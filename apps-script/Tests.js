/**
 * Run these from the Apps Script editor (select function → Run). Output is in the Execution log.
 * Order: testConfig → testStediMock → seedMockVerification → processQueue
 */

/** 1. Are all Script Properties set, and can we reach Supabase? */
function testConfig() {
  ['STEDI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WEBHOOK_SECRET'].forEach(function (k) {
    console.log(k + ': ' + (cfg_(k, false) ? 'set' : 'MISSING'));
  });
  var pb = sbSelect_('payer_playbooks', 'select=stedi_payer_id,name');
  console.log('Supabase OK. Payer playbooks: ' + pb.map(function (p) { return p.name; }).join(', '));
  var prov = sbSelect_('providers', 'select=id,name,npi,practice_id&limit=5');
  console.log('Providers: ' + (prov.length ? JSON.stringify(prov) : 'NONE. Add one (see docs/SETUP.md step 1.4)'));
}

/** 2. Stedi test-mode mock (UHC, active coverage), chiro profile. No database writes. */
function testStediMock() {
  var req = buildEligibilityRequest({
    payerId: '87726', providerName: 'Demo Clinic', npi: '1999999984',
    firstName: 'Jane', lastName: 'Doe', dob: '1971-01-01', memberId: 'UHC123456', serviceCodes: ['33']
  });
  var resp = checkEligibility(req, { retryWindowMs: 5000 });
  var n = normalizeStediResponse(resp, { profile: 'chiro' });
  console.log('HTTP ' + resp.httpStatus + ' · ' + n.outcome);
  console.log(plainSummary(n));
  console.log('Gaps: ' + (n.gaps.join(', ') || 'none'));
  console.log('Route: ' + JSON.stringify(route(n, null, 'stedi')));
}

/** 3. Insert a queued verification for Stedi's mock patient, using the first provider on file. */
function seedMockVerification() {
  var prov = sbSelect_('providers', 'select=id,practice_id&limit=1')[0];
  if (!prov) throw new Error('No providers yet. Add one first (docs/SETUP.md step 1.4).');
  var row = sbInsert_('verifications', {
    practice_id: prov.practice_id, provider_id: prov.id, stedi_payer_id: '87726',
    patient_first_name: 'Jane', patient_last_name: 'Doe', patient_dob: '1971-01-01', member_id: 'UHC123456',
    specialty_profile: 'chiro', service_codes: ['33'], status: 'queued'
  });
  console.log('Queued verification ' + row.id + '. Now run processQueue (or wait for the 1-minute trigger).');
}

/** Simulates a Retell call_analyzed webhook for the most recent needs_human verification. */
function testRetellWebhook() {
  var v = sbSelect_('verifications', 'status=eq.needs_human&order=created_at.desc&limit=1&select=id')[0];
  if (!v) { console.log('No needs_human verification to test with.'); return; }
  var res = doPost({
    parameter: { secret: cfg_('WEBHOOK_SECRET') },
    postData: { contents: JSON.stringify({
      event: 'call_analyzed',
      call: { call_id: 'test_call', metadata: { verification_id: v.id }, transcript: 'TEST',
              call_analysis: { custom_analysis_data: { visit_limit: 20, deductible_total: 1500, prior_auth_required: false } } }
    }) }
  });
  console.log(res.getContent());
}

/** Shows what the daily recap email would say for each clinic with settings. Sends nothing. */
function previewRecapEmail() {
  var now = new Date();
  sbSelect_('notification_settings', 'select=practice_id,recipients,practices(name,timezone)').forEach(function (s) {
    var m = practiceRecap_(s.practice_id, new Date(now.getTime() - 24 * 3600 * 1000), now);
    var mail = recapEmail_(m, appUrl_(), (s.practices && s.practices.timezone) || 'America/New_York', now);
    console.log('To: ' + s.recipients.join(', ') + '\nSubject: ' + mail.subject + '\n\n' + mail.text);
  });
}
