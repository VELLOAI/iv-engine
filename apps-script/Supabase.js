/**
 * Minimal Supabase REST (PostgREST) client using the service role / secret key.
 * The service role bypasses RLS — this key lives only in Script Properties.
 */

function sb_(method, path, body, prefer) {
  var key = cfg_('SUPABASE_SERVICE_ROLE_KEY');
  var headers = { apikey: key };
  // Legacy service_role keys are JWTs (eyJ...) and also go in Authorization.
  // New secret keys (sb_secret_...) are sent as apikey only.
  if (key.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + key;
  if (prefer) headers.Prefer = prefer;
  var opts = { method: method, headers: headers, muteHttpExceptions: true };
  if (body !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }

  var url = cfg_('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1/' + path;
  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code >= 300) throw new Error('Supabase ' + method + ' ' + path.split('?')[0] + ' → ' + code + ': ' + text.slice(0, 500));
  return text ? JSON.parse(text) : null;
}

function sbSelect_(table, query) { return sb_('get', table + '?' + query); }
function sbInsert_(table, row) { return sb_('post', table, row, 'return=representation')[0]; }
function sbUpdate_(table, filter, patch) { return sb_('patch', table + '?' + filter, patch, 'return=representation'); }
function sbUpsert_(table, rows, onConflict) {
  if (!rows.length) return [];
  return sb_('post', table + '?on_conflict=' + onConflict, rows, 'resolution=merge-duplicates,return=minimal');
}
function eq_(v) { return 'eq.' + encodeURIComponent(v); }
