/**
 * processQueue — run by a time-driven trigger every minute.
 * Claims queued verifications, runs stage 1 (Stedi), writes the attempt, the
 * field-level results, and the routing decision back to Supabase.
 */

function processQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { console.log('Previous run still going; skipping.'); return; }
  var started = Date.now();
  try {
    if (stageEnabled_('browserbase')) pollBrowserbase_();   // finish portal lookups started earlier

    var queued = sbSelect_('verifications',
      'status=eq.queued&order=created_at.asc&limit=' + QUEUE_BATCH_SIZE + '&select=id');
    var done = 0;
    for (var i = 0; i < queued.length; i++) {
      if (Date.now() - started > RUN_TIME_BUDGET_MS - STEDI_RETRY_WINDOW_MS) break; // leave room for a slow payer
      // Claim atomically: only succeeds if it's still queued.
      var claimed = sbUpdate_('verifications', 'id=' + eq_(queued[i].id) + '&status=eq.queued',
        { status: 'running', current_stage: 'stedi' });
      if (!claimed.length) continue;
      runStedi_(claimed[0]);
      done++;
    }
    console.log('processQueue: ' + done + ' verification(s) processed in ' + (Date.now() - started) + ' ms');
  } finally {
    lock.releaseLock();
  }
}

function runStedi_(v) {
  var attempt = null;
  try {
    var provider = sbSelect_('providers', 'id=' + eq_(v.provider_id) + '&select=npi,name')[0];
    if (!provider) throw new Error('Provider not found: ' + v.provider_id);
    var playbook = sbSelect_('payer_playbooks', 'stedi_payer_id=' + eq_(v.stedi_payer_id))[0] || null;

    var req = buildRequestForVerification_(v, provider);
    attempt = sbInsert_('verification_attempts', {
      verification_id: v.id, stage: 'stedi', status: 'running', gaps_in: FIELD_KEYS.required
    });

    var resp = checkEligibility(req);
    var n = normalizeStediResponse(resp, { profile: v.specialty_profile, serviceCodes: v.service_codes });
    var r = route(n, playbook, 'stedi');

    var attemptStatus = {
      complete: 'succeeded', inactive_coverage: 'succeeded', gaps: 'partial',
      retryable_error: 'retryable_error', patient_data_error: 'data_error',
      enrollment_error: 'enrollment_error', unknown_error: 'failed'
    }[n.outcome] || 'failed';

    sbUpdate_('verification_attempts', 'id=' + eq_(attempt.id), {
      status: attemptStatus,
      gaps_out: n.gaps,
      error_codes: n.errors.map(function (e) { return e.code; }).concat(resp.httpStatus >= 400 || resp.httpStatus === 0 ? ['HTTP_' + resp.httpStatus] : []),
      external_ref: (resp.body && resp.body.id) || null,
      raw: resp.body,                       // PHI — purged by the retention cron
      finished_at: new Date().toISOString()
    });

    writeFields_(v.id, attempt.id, n.fields);

    // Error / inactive outcomes keep Stedi's own explanation; otherwise summarize all fields on file.
    var stediText = (n.outcome === 'gaps' || n.outcome === 'complete') ? null : plainSummary(n);
    advance_(v, r, playbook, { stage: 'stedi', summaryText: stediText, outcome: n.outcome, errors: n.errors });
  } catch (err) {
    console.error('Verification ' + v.id + ' failed: ' + (err && err.stack || err));
    if (attempt) sbUpdate_('verification_attempts', 'id=' + eq_(attempt.id),
      { status: 'failed', error_codes: ['ENGINE_ERROR'], finished_at: new Date().toISOString() });
    sbUpdate_('verifications', 'id=' + eq_(v.id), {
      status: 'failed', summary: { text: 'Engine error. Will need a retry.', error: String(err && err.message || err) }
    });
  }
}

function buildRequestForVerification_(v, provider) {
  var base = { payerId: v.stedi_payer_id, providerName: provider.name, npi: provider.npi, serviceCodes: v.service_codes };
  if (v.is_dependent && v.subscriber) {
    // Patient is a dependent: subscriber identity comes from v.subscriber.
    return buildEligibilityRequest(Object.assign(base, {
      firstName: v.subscriber.firstName, lastName: v.subscriber.lastName, dob: v.subscriber.dob,
      memberId: v.member_id || v.subscriber.memberId,
      dependent: { firstName: v.patient_first_name, lastName: v.patient_last_name, dob: v.patient_dob }
    }));
  }
  return buildEligibilityRequest(Object.assign(base, {
    firstName: v.patient_first_name, lastName: v.patient_last_name, dob: v.patient_dob, memberId: v.member_id
  }));
}

/** Upsert normalized fields; later stages overwrite earlier ones for the same key. */
function writeFields_(verificationId, attemptId, fields) {
  var now = new Date().toISOString();
  var rows = Object.keys(fields).map(function (k) {
    return { verification_id: verificationId, field_key: k, value: fields[k].value, source: fields[k].source,
             attempt_id: attemptId, evidence: fields[k].evidence || null, updated_at: now };
  });
  sbUpsert_('verification_fields', rows, 'verification_id,field_key');
}

/** Re-queue failed or retryable verifications (run by hand, or add a trigger later). */
function requeueFailed() {
  var rows = sbUpdate_('verifications', 'status=eq.failed', { status: 'queued', current_stage: null });
  console.log('Re-queued ' + rows.length + ' verification(s).');
}

/**
 * Apply a routing decision: start the next automated stage, or settle the verification.
 * opts: { stage, summaryText, outcome, errors, note }
 */
function advance_(v, r, playbook, opts) {
  opts = opts || {};
  if (r.nextStage === 'browserbase') {
    try { return startBrowserbase_(v, r.gaps, playbook); }
    catch (err) {
      console.error('Browserbase start failed for ' + v.id + ': ' + (err && err.message || err));
      var gaps = currentGaps_(v.id);
      r = route({ outcome: 'unknown_error', gaps: gaps, errors: [], fields: {} }, playbook, 'browserbase');
      opts.note = 'Portal lookup could not start: ' + (err && err.message || err);
    }
  }
  if (r.nextStage === 'retell') {
    // Retell dispatch is the next build; until then gaps go to staff.
    r = { status: 'needs_human', nextStage: 'human', gaps: r.gaps, reason: r.reason + ' (Retell stage not built yet → human)' };
  }
  var finished = r.nextStage === null;
  var gapsNow = finished ? [] : r.gaps;
  sbUpdate_('verifications', 'id=' + eq_(v.id), {
    status: r.status,
    current_stage: finished ? (opts.stage || 'stedi') : r.nextStage,
    open_gaps: gapsNow,
    summary: {
      text: opts.summaryText || summaryFromDb_(v.id, gapsNow),
      outcome: opts.outcome || (gapsNow.length ? 'gaps' : 'complete'),
      reason: r.reason,
      errors: opts.errors || [],
      note: opts.note || null
    },
    completed_at: finished ? new Date().toISOString() : null
  });
}

/** Required fields not yet answered by any stage. */
function currentGaps_(verificationId) {
  var have = sbSelect_('verification_fields', 'verification_id=' + eq_(verificationId) + '&select=field_key')
    .map(function (r) { return r.field_key; });
  return FIELD_KEYS.required.filter(function (k) { return have.indexOf(k) === -1; });
}

/** Plain-language summary built from every field on file (all stages). */
function summaryFromDb_(verificationId, gaps) {
  var rows = sbSelect_('verification_fields', 'verification_id=' + eq_(verificationId) + '&select=field_key,value');
  var fields = {};
  rows.forEach(function (r) { fields[r.field_key] = { value: r.value }; });
  return plainSummary({ outcome: gaps.length ? 'gaps' : 'complete', fields: fields, gaps: gaps, errors: [] });
}
