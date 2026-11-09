/**
 * Stage 1 — Stedi Real-Time Eligibility (270/271), redesigned JSON endpoint.
 * Apps Script port of engine/stedi-client.mjs.
 */

var RETRYABLE_HTTP_ = [429, 502, 503, 504];
var RETRYABLE_AAA_ = ['42']; // not 79: Stedi returns 79 (wrong payer/participant) as HTTP 400

/** dob / dependent.dob must be YYYY-MM-DD. serviceCodes are STCs, e.g. ['33']. */
function buildEligibilityRequest(p) {
  var body = {
    payerId: p.payerId,
    provider: { name: { organization: p.providerName }, npi: p.npi },
    subscriber: {
      name: { person: { firstName: p.firstName, lastName: p.lastName } },
      dateOfBirth: p.dob
    },
    // Stedi recommends one STC per request.
    encounter: { services: (p.serviceCodes || ['30']).slice(0, 1).map(function (v) { return { system: 'STC', value: v }; }) }
  };
  if (p.memberId) body.subscriber.memberId = p.memberId;
  if (p.dependent) {
    body.dependents = [{
      name: { person: { firstName: p.dependent.firstName, lastName: p.dependent.lastName } },
      dateOfBirth: p.dependent.dob
    }];
  }
  return body;
}

/**
 * One eligibility check with retries for payer/connection outages.
 * Returns { ok, httpStatus, body, tries, elapsedMs }. Payer errors don't throw.
 */
function checkEligibility(body, opts) {
  opts = opts || {};
  var apiKey = opts.apiKey || cfg_('STEDI_API_KEY');
  var retryWindowMs = opts.retryWindowMs != null ? opts.retryWindowMs : STEDI_RETRY_WINDOW_MS;
  var started = Date.now();
  var tries = 0, last;

  while (true) {
    tries++;
    try {
      var res = UrlFetchApp.fetch(opts.url || STEDI_ELIGIBILITY_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: apiKey },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      var status = res.getResponseCode();
      var text = res.getContentText();
      var json;
      try { json = JSON.parse(text); } catch (e) { json = { rawText: text }; }
      var headers = res.getHeaders() || {};
      last = { ok: status >= 200 && status < 300, httpStatus: status, body: json,
               retryAfter: headers['Retry-After'] || headers['retry-after'] };
      var aaa = (json && json.errors || []).map(function (e) { return String(e.code); });
      var retryable = RETRYABLE_HTTP_.indexOf(status) !== -1 || status >= 500 ||
        aaa.some(function (c) { return RETRYABLE_AAA_.indexOf(c) !== -1; });
      if (!retryable) break;
    } catch (err) {
      last = { ok: false, httpStatus: 0, body: { networkError: String(err && err.message || err) } };
    }
    var elapsed = Date.now() - started;
    if (elapsed >= retryWindowMs) break;
    var backoff = last.retryAfter ? Number(last.retryAfter) * 1000 : Math.min(Math.pow(2, tries) * 1000, 20000);
    Utilities.sleep(Math.min(backoff, retryWindowMs - elapsed));
  }
  return { ok: last.ok, httpStatus: last.httpStatus, body: last.body, tries: tries, elapsedMs: Date.now() - started };
}
