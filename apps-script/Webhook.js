/**
 * Web app endpoints.
 *   GET  …/exec                      → health check
 *   POST …/exec?secret=WEBHOOK_SECRET → Retell webhook (call_analyzed)
 *
 * Apps Script web apps can't read custom headers, so the shared secret rides in the URL.
 * Apps Script answers POSTs with a 302 redirect; Retell follows it. curl doesn't, so
 * test with testRetellWebhook() in the editor.
 *
 * Retell contract (for the gap-call agent, built next):
 *   call.metadata.verification_id               → which verification this call is for
 *   call.call_analysis.custom_analysis_data     → { <field_key>: value, ... } using FIELD_KEYS names
 */

function doGet() {
  return json_({ ok: true, service: 'iv-engine', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.secret !== cfg_('WEBHOOK_SECRET')) return json_({ ok: false, error: 'unauthorized' });
    var payload = JSON.parse((e.postData && e.postData.contents) || '{}');
    if (payload.event !== 'call_analyzed') return json_({ ok: true, ignored: payload.event || 'unknown' });

    var call = payload.call || {};
    var verificationId = call.metadata && call.metadata.verification_id;
    if (!verificationId) return json_({ ok: true, ignored: 'no verification_id in call metadata' });

    handleRetellResult_(verificationId, call);
    return json_({ ok: true });
  } catch (err) {
    console.error('doPost error: ' + (err && err.stack || err));
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function handleRetellResult_(verificationId, call) {
  var data = (call.call_analysis && call.call_analysis.custom_analysis_data) || {};
  var known = FIELD_KEYS.required.concat(FIELD_KEYS.optional);
  var excerpt = String(call.transcript || '').slice(0, 500);

  var v = sbSelect_('verifications', 'id=' + eq_(verificationId) + '&select=id,open_gaps')[0];
  if (!v) throw new Error('Unknown verification ' + verificationId);

  var attempt = sbInsert_('verification_attempts', {
    verification_id: verificationId, stage: 'retell', status: 'running',
    gaps_in: v.open_gaps || [], external_ref: call.call_id || null
  });

  var fields = {};
  Object.keys(data).forEach(function (k) {
    var val = data[k];
    if (known.indexOf(k) === -1 || val === null || val === undefined || val === '' || val === 'unknown') return;
    fields[k] = { value: val, source: 'retell', evidence: excerpt || null };
  });
  writeFields_(verificationId, attempt.id, fields);

  var gaps = currentGaps_(verificationId);
  sbUpdate_('verification_attempts', 'id=' + eq_(attempt.id), {
    status: gaps.length ? 'partial' : 'succeeded', gaps_out: gaps, finished_at: new Date().toISOString()
  });
  var full = sbSelect_('verifications', 'id=' + eq_(verificationId))[0];
  var playbook = sbSelect_('payer_playbooks', 'stedi_payer_id=' + eq_(full.stedi_payer_id))[0] || null;
  advance_(full, route({ outcome: gaps.length ? 'gaps' : 'complete', gaps: gaps, errors: [], fields: {} }, playbook, 'retell'),
           playbook, { stage: 'retell' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
