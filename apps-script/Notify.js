/**
 * Clinic emails: daily recap ("pulse") + "patients need your attention" alerts. Migration 008.
 *
 * Runs on its own 5-minute trigger (run installNotificationTrigger once).
 * Sends through Resend. Resend is NOT covered by a BAA, so these emails carry counts and
 * insurer names only — never patient names, DOBs or member IDs. Staff sign in to see who.
 *
 * Script Properties:
 *   RESEND_API_KEY   re_...            (required to send; without it every send is logged as skipped)
 *   NOTIFY_FROM      ClearCover <reports@yourdomain.com>   (domain must be verified in Resend;
 *                    until then Resend only delivers from onboarding@resend.dev to the account owner)
 *   APP_URL          https://velloai-ins-verify.lovable.app
 */

var ATTENTION_EVERY_MS = 3 * 60 * 60 * 1000;   // at most one attention alert per clinic every 3 hours
var ATTENTION_HOURS = [8, 18];                 // clinic-local hours when attention alerts may go out
var RECAP_LATE_HOURS = 3;                      // still send the recap up to 3h after the set hour (engine hiccups)

function runNotifications() {
  var lock = LockService.getUserLock();        // processQueue holds the script lock; don't wait on it
  if (!lock.tryLock(2000)) return;
  try {
    sendRequestedTests_();
    var rows = sbSelect_('notification_settings', 'select=*,practices(name,timezone)');
    rows.forEach(function (s) {
      try { notifyPractice_(s, new Date()); }
      catch (e) { console.error('Notify ' + s.practice_id + ': ' + e.message); }
    });
  } finally { lock.releaseLock(); }
}

function notifyPractice_(s, now) {
  if (!s.recipients || !s.recipients.length) return;
  var tz = (s.practices && s.practices.timezone) || 'America/New_York';
  var today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var hour = Number(Utilities.formatDate(now, tz, 'H'));
  var recapSent = false;

  if (s.daily_recap && s.last_recap_on !== today && hour >= s.recap_hour && hour < s.recap_hour + RECAP_LATE_HOURS) {
    var m = practiceRecap_(s.practice_id, new Date(now.getTime() - 24 * 3600 * 1000), now);
    var quiet = !m.finished && !m.uploaded && !m.needs_attention_open && !m.still_working;
    if (quiet) {
      logNotification_(s.practice_id, 'daily_recap', 'skipped', s.recipients, null, m, 'Nothing to report');
    } else {
      var mail = recapEmail_(m, appUrl_(), tz, now);
      deliver_(s.practice_id, 'daily_recap', s.recipients, mail, m);
      recapSent = true;
    }
    sbUpdate_('notification_settings', 'practice_id=' + eq_(s.practice_id),
      recapSent ? { last_recap_on: today, last_attention_at: now.toISOString() } : { last_recap_on: today });
  }

  if (!recapSent && s.attention_alerts && hour >= ATTENTION_HOURS[0] && hour < ATTENTION_HOURS[1]) {
    var last = s.last_attention_at ? new Date(s.last_attention_at) : null;
    if (last && now.getTime() - last.getTime() < ATTENTION_EVERY_MS) return;
    var since = last || new Date(now.getTime() - 24 * 3600 * 1000);
    var a = practiceRecap_(s.practice_id, since, now);
    if (a.needs_attention_new > 0 && a.needs_attention_open > 0) {
      deliver_(s.practice_id, 'attention', s.recipients, attentionEmail_(a, appUrl_()), a);
      sbUpdate_('notification_settings', 'practice_id=' + eq_(s.practice_id), { last_attention_at: now.toISOString() });
    }
  }
}

/** Test emails requested from the admin screen (admin_request_test_email). */
function sendRequestedTests_() {
  var reqs = sbSelect_('notification_log', 'status=eq.requested&order=created_at.asc&limit=5&select=id,practice_id,recipients');
  reqs.forEach(function (r) {
    var patch;
    try {
      var p = sbSelect_('practices', 'id=' + eq_(r.practice_id) + '&select=timezone')[0] || {};
      var now = new Date();
      var m = practiceRecap_(r.practice_id, new Date(now.getTime() - 24 * 3600 * 1000), now);
      var mail = recapEmail_(m, appUrl_(), p.timezone || 'America/New_York', now);
      mail.subject = '[Test] ' + mail.subject;
      var res = sendEmail_(r.recipients, mail);
      patch = { status: res.ok ? 'sent' : (res.skipped ? 'skipped' : 'failed'), subject: mail.subject, metrics: m,
                error: res.error || null, sent_at: res.ok ? now.toISOString() : null };
    } catch (e) {
      patch = { status: 'failed', error: String(e.message).slice(0, 500) };
    }
    sbUpdate_('notification_log', 'id=' + eq_(r.id), patch);
  });
}

function practiceRecap_(practiceId, since, until) {
  return sb_('post', 'rpc/iv_practice_recap',
    { p_practice_id: practiceId, p_since: since.toISOString(), p_until: until.toISOString() });
}

function deliver_(practiceId, kind, to, mail, metrics) {
  var res = sendEmail_(to, mail);
  logNotification_(practiceId, kind, res.ok ? 'sent' : (res.skipped ? 'skipped' : 'failed'), to, mail.subject, metrics, res.error);
}

function logNotification_(practiceId, kind, status, to, subject, metrics, error) {
  sbInsert_('notification_log', {
    practice_id: practiceId, kind: kind, status: status, recipients: to, subject: subject,
    metrics: metrics, error: error || null, sent_at: status === 'sent' ? new Date().toISOString() : null
  });
}

function sendEmail_(to, mail) {
  var key = cfg_('RESEND_API_KEY', false);
  if (!key) return { ok: false, skipped: true, error: 'RESEND_API_KEY not set' };
  var from = cfg_('NOTIFY_FROM', false) || 'ClearCover <onboarding@resend.dev>';
  var res = UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify({ from: from, to: to, subject: mail.subject, html: mail.html, text: mail.text })
  });
  var code = res.getResponseCode();
  if (code >= 300) return { ok: false, error: 'Resend ' + code + ': ' + res.getContentText().slice(0, 300) };
  return { ok: true };
}

function appUrl_() {
  return String(cfg_('APP_URL', false) || 'https://velloai-ins-verify.lovable.app').replace(/\/+$/, '');
}

// ───────────── email content (counts only, no patient identifiers) ─────────────

function n_(v) { return Number(v) || 0; }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function money_(v) {
  if (v == null || v === '') return null;
  var x = Number(v); if (isNaN(x)) return null;
  return '$' + x.toFixed(x % 1 ? 2 : 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function plural_(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

/** The "what's coming in" lines, shared by the recap email and the admin preview. */
function recapInsights_(m) {
  var v = n_(m.verified), out = [];
  if (!v) return out;
  var hi = money_(m.thresholds && m.thresholds.high_deductible) || '$2,500';
  var lo = money_(m.thresholds && m.thresholds.low_copay) || '$40';
  if (n_(m.high_deductible)) out.push(n_(m.high_deductible) + ' of ' + v + ' have a high deductible (' + hi + '+)');
  if (n_(m.deductible_met)) out.push(n_(m.deductible_met) + ' of ' + v + ' have already met their deductible');
  if (n_(m.low_copay)) out.push(n_(m.low_copay) + ' of ' + v + ' have a copay under ' + lo);
  if (n_(m.coinsurance_plans)) out.push(n_(m.coinsurance_plans) + ' of ' + v + ' pay coinsurance instead of a copay');
  if (n_(m.auth_required)) out.push(plural_(n_(m.auth_required), 'plan') + (n_(m.auth_required) === 1 ? ' needs' : ' need') + ' prior authorization');
  if (m.avg_copay != null) out.push('Average copay: ' + money_(m.avg_copay));
  if (m.avg_deductible_remaining != null) out.push('Average deductible left to meet: ' + money_(m.avg_deductible_remaining));
  return out;
}

function recapEmail_(m, appUrl, tz, now) {
  var clinic = m.practice_name || 'Your clinic';
  var verified = n_(m.verified), finished = n_(m.finished), open = n_(m.needs_attention_open), working = n_(m.still_working);
  var dateLabel = Utilities.formatDate(now, tz, 'EEE, MMM d');

  var subject = clinic + ': ' + verified + ' of ' + finished + ' verified in the last 24 hours' +
    (open ? ' · ' + open + ' need' + (open === 1 ? 's' : '') + ' attention' : '');
  var insights = recapInsights_(m);
  var insurers = (m.by_insurer || []).slice(0, 8);
  var cta = open
    ? { href: appUrl + '/queue', label: 'Review ' + plural_(open, 'patient') }
    : { href: appUrl + '/verifications', label: 'Open dashboard' };

  var text = [
    'ClearCover daily pulse — ' + clinic + ' — ' + dateLabel, '',
    verified + ' of ' + finished + ' patients verified in the last 24 hours.',
    open ? open + ' need your attention: ' + cta.href : 'Nothing needs your attention.',
    working ? working + ' still being checked.' : '',
    insights.length ? '\nWhat\'s coming in:\n- ' + insights.join('\n- ') : '',
    insurers.length ? '\nBy insurer:\n' + insurers.map(function (i) {
      return '- ' + i.insurer + ': ' + n_(i.verified) + ' of ' + n_(i.finished) + ' verified' +
        (n_(i.needs_attention) ? ', ' + n_(i.needs_attention) + ' need' + (n_(i.needs_attention) === 1 ? 's' : '') + ' attention' : '');
    }).join('\n') : '',
    '\nThis email has no patient details. Sign in to see names: ' + appUrl
  ].filter(function (l) { return l !== ''; }).join('\n');

  var stat = function (num, label, color) {
    return '<td width="33%" style="padding:16px 8px;text-align:center;border:1px solid #E6EAF2;border-radius:12px;">' +
      '<div style="font-size:30px;font-weight:700;color:' + color + ';line-height:1;">' + num + '</div>' +
      '<div style="font-size:12px;color:#5B6478;margin-top:6px;">' + label + '</div></td>';
  };
  var rows = insurers.map(function (i) {
    return '<tr><td style="padding:8px 0;border-top:1px solid #EEF1F6;">' + esc_(i.insurer) + '</td>' +
      '<td style="padding:8px 0;border-top:1px solid #EEF1F6;text-align:right;font-family:Menlo,monospace;">' +
      n_(i.verified) + ' / ' + n_(i.finished) + '</td>' +
      '<td style="padding:8px 0;border-top:1px solid #EEF1F6;text-align:right;color:' +
      (n_(i.needs_attention) ? '#C2410C' : '#9AA3B5') + ';">' + (n_(i.needs_attention) ? n_(i.needs_attention) + ' need' + (n_(i.needs_attention) === 1 ? 's' : '') + ' attention' : '—') + '</td></tr>';
  }).join('');

  var html =
    '<div style="background:#F5F7FB;padding:24px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#141B2D;">' +
    '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;">' +
    '<tr><td style="font-size:13px;letter-spacing:3px;color:#141B2D;">CLEAR<span style="color:#2F6FDE;">COVER</span></td></tr>' +
    '<tr><td style="padding-top:18px;font-size:13px;color:#5B6478;">Daily pulse · ' + esc_(dateLabel) + '</td></tr>' +
    '<tr><td style="font-size:22px;font-weight:700;padding-top:4px;">' + esc_(clinic) + '</td></tr>' +
    '<tr><td style="padding-top:20px;"><table role="presentation" width="100%" style="border-spacing:8px 0;"><tr>' +
      stat(verified + '<span style="font-size:16px;color:#9AA3B5;"> / ' + finished + '</span>', 'Verified (24h)', '#15803D') +
      stat(open, 'Need your attention', open ? '#C2410C' : '#141B2D') +
      stat(working, 'Still being checked', '#141B2D') +
    '</tr></table></td></tr>' +
    '<tr><td style="padding-top:22px;"><a href="' + esc_(cta.href) + '" style="display:inline-block;background:#2F6FDE;color:#fff;' +
      'text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;font-size:14px;">' + esc_(cta.label) + ' →</a></td></tr>' +
    (insights.length ? '<tr><td style="padding-top:26px;font-size:15px;font-weight:700;">What\'s coming in</td></tr>' +
      '<tr><td style="padding-top:8px;font-size:14px;line-height:1.7;color:#2A3247;">' +
      insights.map(function (l) { return '• ' + esc_(l); }).join('<br>') + '</td></tr>' : '') +
    (rows ? '<tr><td style="padding-top:26px;font-size:15px;font-weight:700;">By insurer</td></tr>' +
      '<tr><td style="padding-top:4px;"><table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse;">' +
      rows + '</table></td></tr>' : '') +
    '<tr><td style="padding-top:28px;font-size:12px;color:#9AA3B5;line-height:1.6;">This email has no patient details. ' +
      'Sign in to see names. Counts cover the 24 hours before this email was sent.</td></tr>' +
    '</table></div>';

  return { subject: subject, html: html, text: text };
}

function attentionEmail_(m, appUrl) {
  var clinic = m.practice_name || 'Your clinic';
  var open = n_(m.needs_attention_open), fresh = n_(m.needs_attention_new);
  var subject = clinic + ': ' + plural_(open, 'patient') + ' need' + (open === 1 ? 's' : '') + ' your attention';
  var href = appUrl + '/queue';
  var text = fresh + ' new since the last alert, ' + open + ' waiting in total.\n' +
    'Usually a missing member ID, a payer we couldn\'t reach, or inactive coverage.\n' +
    'Review them: ' + href + '\n\nThis email has no patient details. Sign in to see names.';
  var html =
    '<div style="background:#F5F7FB;padding:24px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#141B2D;">' +
    '<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;">' +
    '<tr><td style="font-size:13px;letter-spacing:3px;">CLEAR<span style="color:#2F6FDE;">COVER</span></td></tr>' +
    '<tr><td style="font-size:22px;font-weight:700;padding-top:18px;">' + esc_(plural_(open, 'patient')) + ' need' + (open === 1 ? 's' : '') + ' your attention</td></tr>' +
    '<tr><td style="padding-top:8px;font-size:14px;color:#2A3247;line-height:1.6;">' + esc_(clinic) + ' · ' + fresh +
      ' new since the last alert. Usually a missing member ID, a payer we couldn\'t reach, or inactive coverage.</td></tr>' +
    '<tr><td style="padding-top:20px;"><a href="' + esc_(href) + '" style="display:inline-block;background:#2F6FDE;color:#fff;' +
      'text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;font-size:14px;">Review now →</a></td></tr>' +
    '<tr><td style="padding-top:24px;font-size:12px;color:#9AA3B5;">This email has no patient details. Sign in to see names.</td></tr>' +
    '</table></div>';
  return { subject: subject, html: html, text: text };
}

// ───────────── setup ─────────────

/** Run once from the editor. Safe to re-run: replaces the existing notification trigger. */
function installNotificationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runNotifications') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runNotifications').timeBased().everyMinutes(5).create();
  console.log('runNotifications will run every 5 minutes.');
}
