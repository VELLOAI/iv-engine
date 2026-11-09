/**
 * Stage 2 — Browserbase payer-portal lookup.
 * Invokes the Browserbase Function "iv-portal-benefits" (see /browserbase) asynchronously,
 * then a later processQueue run polls the invocation and writes the results.
 *
 * Script Properties: BROWSERBASE_API_KEY, BROWSERBASE_FUNCTION_ID, BROWSERBASE_ENABLED=true
 */

var BB_API = 'https://api.browserbase.com/v1/functions';
var BB_TIMEOUT_MS = 15 * 60 * 1000; // give up on an invocation after 15 min
var BB_DONE_OK_ = ['COMPLETED', 'SUCCEEDED', 'SUCCESS'];
var BB_DONE_FAIL_ = ['FAILED', 'ERROR', 'ERRORED', 'TIMED_OUT', 'TIMEOUT', 'CANCELLED', 'CANCELED'];

function bbFetch_(method, path, body) {
  var opts = { method: method, headers: { 'x-bb-api-key': cfg_('BROWSERBASE_API_KEY') }, muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(BB_API + path, opts);
  var code = res.getResponseCode(), text = res.getContentText();
  if (code >= 300) throw new Error('Browserbase ' + method + ' ' + path.split('/').slice(0, 2).join('/') + ' → ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

/** Kick off a portal lookup for the verification's open gaps. */
function startBrowserbase_(v, gaps, playbook) {
  var provider = sbSelect_('providers', 'id=' + eq_(v.provider_id) + '&select=npi')[0];
  var params = {
    portal: playbook.portal_type === 'mock' ? 'mock' : (playbook.portal_type || 'availity'),
    payerId: v.stedi_payer_id,
    payerName: playbook.name,
    providerNpi: provider.npi,
    patient: { firstName: v.patient_first_name, lastName: v.patient_last_name, dob: v.patient_dob, memberId: v.member_id || undefined },
    serviceCodes: v.service_codes,
    gaps: gaps,
    verificationId: v.id
  };
  var inv = bbFetch_('post', '/' + cfg_('BROWSERBASE_FUNCTION_ID') + '/invoke', { params: params });
  if (!inv.id) throw new Error('Browserbase invoke returned no invocation id');
  sbInsert_('verification_attempts', {
    verification_id: v.id, stage: 'browserbase', status: 'running', gaps_in: gaps, external_ref: inv.id
  });
  sbUpdate_('verifications', 'id=' + eq_(v.id), {
    status: 'running', current_stage: 'browserbase', open_gaps: gaps,
    summary: { text: summaryFromDb_(v.id, gaps), outcome: 'gaps', reason: 'Checking the payer portal for ' + gaps.length + ' field(s).' }
  });
}

/** Poll running Browserbase attempts; write results and route onward when done. */
function pollBrowserbase_() {
  var running = sbSelect_('verification_attempts', 'stage=eq.browserbase&status=eq.running&select=id,verification_id,external_ref,started_at,gaps_in');
  running.forEach(function (a) {
    try {
      var inv = bbFetch_('get', '/invocations/' + encodeURIComponent(a.external_ref));
      var status = String(inv.status || '').toUpperCase();
      var age = Date.now() - new Date(a.started_at).getTime();
      if (BB_DONE_OK_.indexOf(status) !== -1) return finishBrowserbase_(a, inv.results || {});
      if (BB_DONE_FAIL_.indexOf(status) !== -1 || age > BB_TIMEOUT_MS) {
        return finishBrowserbase_(a, { status: 'error', fields: {}, message: 'Invocation ' + (status || 'timed out') });
      }
      // still pending/running — check again next minute
    } catch (err) {
      console.error('pollBrowserbase_ ' + a.id + ': ' + (err && err.message || err));
    }
  });
}

function finishBrowserbase_(attempt, result) {
  var fields = {};
  var raw = result.fields || {};
  Object.keys(raw).forEach(function (k) {
    if (FIELD_KEYS.required.indexOf(k) === -1 && FIELD_KEYS.optional.indexOf(k) === -1) return;
    fields[k] = { value: raw[k].value, source: 'browserbase', evidence: raw[k].evidence || null };
  });
  writeFields_(attempt.verification_id, attempt.id, fields);

  var gaps = currentGaps_(attempt.verification_id);
  var attemptStatus = result.status === 'ok' ? (gaps.length ? 'partial' : 'succeeded') : 'failed';
  sbUpdate_('verification_attempts', 'id=' + eq_(attempt.id), {
    status: attemptStatus, gaps_out: gaps,
    error_codes: result.status === 'ok' ? [] : ['PORTAL_' + String(result.status || 'error').toUpperCase()],
    raw: { status: result.status, message: result.message || null, sessionId: result.sessionId || null }, // no PHI
    finished_at: new Date().toISOString()
  });

  var v = sbSelect_('verifications', 'id=' + eq_(attempt.verification_id))[0];
  var playbook = sbSelect_('payer_playbooks', 'stedi_payer_id=' + eq_(v.stedi_payer_id))[0] || null;
  var n = { outcome: gaps.length ? (result.status === 'ok' ? 'gaps' : 'unknown_error') : 'complete', gaps: gaps, errors: [], fields: {} };
  advance_(v, route(n, playbook, 'browserbase'), playbook,
           { stage: 'browserbase', note: result.status !== 'ok' ? (result.message || ('Portal lookup ' + result.status)) : null });
}
