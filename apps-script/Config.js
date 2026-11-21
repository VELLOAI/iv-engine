/**
 * IV Engine — configuration.
 * Secrets live in Script Properties (Project Settings → Script Properties), never in this repo:
 *   STEDI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WEBHOOK_SECRET
 * Optional (enable later stages):
 *   RETELL_ENABLED = "true"       → gaps route to the Retell stage instead of the human queue
 *   BROWSERBASE_ENABLED = "true"  → gaps route to the Browserbase stage first
 *     (also needs BROWSERBASE_API_KEY and BROWSERBASE_FUNCTION_ID, and the payer's playbook
 *      to have portal_automation_enabled = true)
 */

var STEDI_ELIGIBILITY_URL = 'https://healthcare.us.stedi.com/2026-06-01/eligibility-check';

var QUEUE_BATCH_SIZE = 10;          // verifications claimed per trigger run
var RUN_TIME_BUDGET_MS = 270000;    // stop starting new work after 4.5 min (Apps Script hard limit is 6)
var STEDI_RETRY_WINDOW_MS = 120000; // Stedi guidance: retry payer outages for up to ~2 min

// Google-side blips seen in production (Nov 20): "Address unavailable" from UrlFetchApp and
// "a server error occurred while reading from storage" from PropertiesService. Both clear on retry.
var TRANSIENT_ERROR_RE_ = /Address unavailable|DNS error|timed out|Timeout|server error occurred|Service invoked too many times|Bandwidth quota|temporarily unavailable/i;

function isTransient_(e) { return TRANSIENT_ERROR_RE_.test(String(e && e.message || e)); }

/** Runs fn, retrying up to 3 times (1s, 2s, 4s) when Google reports a transient failure. */
function withRetry_(fn) {
  for (var i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (i >= 3 || !isTransient_(e)) throw e;
      Utilities.sleep(1000 * Math.pow(2, i));
    }
  }
}

var PROPS_CACHE_ = null;
function cfg_(key, required) {
  if (!PROPS_CACHE_) PROPS_CACHE_ = withRetry_(function () { return PropertiesService.getScriptProperties().getProperties(); });
  var v = PROPS_CACHE_[key];
  if (required !== false && !v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function stageEnabled_(stage) {
  if (stage === 'browserbase') return cfg_('BROWSERBASE_ENABLED', false) === 'true';
  if (stage === 'retell') return cfg_('RETELL_ENABLED', false) === 'true';
  return true;
}
