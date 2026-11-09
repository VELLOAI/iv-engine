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

function cfg_(key, required) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  if (required !== false && !v) throw new Error('Missing Script Property: ' + key);
  return v;
}

function stageEnabled_(stage) {
  if (stage === 'browserbase') return cfg_('BROWSERBASE_ENABLED', false) === 'true';
  if (stage === 'retell') return cfg_('RETELL_ENABLED', false) === 'true';
  return true;
}
