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

    var finished = r.nextStage === null;
    sbUpdate_('verifications', 'id=' + eq_(v.id), {
      status: r.status,
      current_stage: finished ? 'stedi' : r.nextStage,
      open_gaps: r.gaps,
      summary: { text: plainSummary(n), outcome: n.outcome, reason: r.reason, errors: n.errors },
      completed_at: finished ? new Date().toISOString() : null
    });
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
