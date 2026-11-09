/**
 * 271 (2026-06-01 JSON shape) → normalized fields for one specialty profile,
 * gap list, and an outcome for the router. Apps Script port of engine/normalize.mjs.
 * Written without ?. / ?? so it runs on any Apps Script V8 build.
 */

var PROFILE_STCS = {
  chiro: ['33'],
  physical_therapy: ['PT'],
  behavioral_health: ['MH', 'A6', 'A7', 'A8'],
  office_visit_specialist: ['96', '98']
};

var FIELD_KEYS = {
  required: ['coverage_active', 'plan_name', 'network_status', 'copay', 'coinsurance',
             'deductible_total', 'deductible_remaining', 'oop_max_total', 'oop_remaining',
             'visit_limit', 'prior_auth_required'],
  optional: ['group_number', 'plan_start', 'visits_used', 'carve_out_vendor', 'payer_messages',
             'insurance_type', 'coverage_limit_amount', 'covered_amount']
};

var AAA_CLASS_ = {
  retryable: ['42'],
  payerId: ['79'],
  patientData: ['15', '58', '60', '62', '64', '65', '67', '71', '72', '73', '75', '76', '77'],
  enrollment: ['41', '43', '44', '45', '46', '47', '50', '51', '52', '56']
};

var NETWORK_PREF_ = ['IN_NETWORK', 'IN_AND_OUT_OF_NETWORK', 'NOT_APPLICABLE', undefined];
var LEVEL_PREF_ = ['INDIVIDUAL', 'EMPLOYEE', undefined, 'FAMILY'];
var TOTAL_PERIODS_ = ['CALENDAR_YEAR', 'SERVICE_YEAR', 'CONTRACT', 'YEAR_TO_DATE', 'LIFETIME', 'EPISODE'];

function g_(o, path) { // safe getter: g_(x, 'a.b.c')
  var parts = path.split('.');
  for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
  return o;
}
function stcOf_(e) { return g_(e, 'service.system') === 'STC' ? e.service.value : undefined; }
function rank_(arr, v) { var i = arr.indexOf(v); return i === -1 ? arr.length : i; }
function inList_(list, v) { return list.indexOf(v) !== -1; }

function pick_(entries, stcs, opts) {
  opts = opts || {};
  entries = entries || [];
  var pool = entries.filter(function (e) { return inList_(stcs, stcOf_(e)); });
  if (!pool.length && opts.allowFallback) pool = entries.filter(function (e) { return stcOf_(e) === '30'; });
  if (opts.timePeriods) pool = pool.filter(function (e) { return inList_(opts.timePeriods, e.timePeriod); });
  if (!pool.length) return undefined;
  return pool.slice().sort(function (a, b) {
    return (rank_(NETWORK_PREF_, g_(a, 'network.indicator')) - rank_(NETWORK_PREF_, g_(b, 'network.indicator'))) ||
           (rank_(LEVEL_PREF_, a.coverageLevel) - rank_(LEVEL_PREF_, b.coverageLevel)) ||
           (stcs.indexOf(stcOf_(a)) - stcs.indexOf(stcOf_(b)));
  })[0];
}

function field_(value, entry, note) {
  if (value === undefined || value === null || (typeof value === 'number' && isNaN(value))) return undefined;
  var ev = [note].concat((entry && entry.messages) || []).filter(Boolean).join(' | ');
  var f = { value: value, source: 'stedi' };
  if (ev) f.evidence = ev;
  return f;
}

function num_(v) { return v === undefined || v === null ? undefined : Number(v); }

function normalizeStediResponse(resp, opts) {
  opts = opts || {};
  var body = (resp && resp.body !== undefined) ? resp.body : resp;
  var httpStatus = (resp && resp.httpStatus !== undefined) ? resp.httpStatus : 200;
  var stcs = opts.serviceCodes || PROFILE_STCS[opts.profile || 'chiro'] || ['30'];
  var errors = ((body && body.errors) || []).map(function (e) {
    return { code: String(e.code), description: e.description, followupAction: e.followupAction };
  });
  var codes = errors.map(function (e) { return e.code; });
  var any = function (list) { return codes.some(function (c) { return inList_(list, c); }); };

  // 1. errors before benefits
  if (httpStatus === 0 || httpStatus === 429 || httpStatus >= 500 || any(AAA_CLASS_.retryable)) return nResult_('retryable_error', { errors: errors });
  if (any(AAA_CLASS_.enrollment)) return nResult_('enrollment_error', { errors: errors });
  if (any(AAA_CLASS_.patientData) || any(AAA_CLASS_.payerId)) return nResult_('patient_data_error', { errors: errors });
  var plans = (body && body.plans) || [];
  if (httpStatus >= 400 || (errors.length && !plans.length)) return nResult_('unknown_error', { errors: errors });

  // 2. benefits
  var b = mergeBenefits_(plans);
  var fields = {};
  var set = function (k, v) { if (v) fields[k] = v; };

  var planStatus = pick_(b.statuses, ['30']);
  if (planStatus) set('coverage_active', field_(planStatus.status === 'ACTIVE_COVERAGE', planStatus, planStatus.status));
  var namedPlan = plans.filter(function (p) { return p.name; })[0];
  set('plan_name', field_(namedPlan ? namedPlan.name : g_(planStatus, 'planCoverageDescription'), planStatus));
  set('group_number', field_(g_(body, 'subscriber.additionalInformation.group.number')));
  set('plan_start', field_(g_(body, 'subscriber.dates.plan.start')));
  set('insurance_type', field_(g_(planStatus, 'insuranceType')));

  if (fields.coverage_active && fields.coverage_active.value === false) {
    return nResult_('inactive_coverage', { errors: errors, fields: fields, gaps: [] });
  }

  var svcStatus = pick_(b.statuses, stcs);
  set('network_status', field_(g_(svcStatus, 'network.indicator'), svcStatus, g_(svcStatus, 'service.definition')));

  var copay = pick_(b.coPayment, stcs);
  set('copay', field_(num_(g_(copay, 'amount')), copay, [g_(copay, 'timePeriod'), g_(copay, 'service.definition')].filter(Boolean).join(' ')));
  var coins = pick_(b.coInsurance, stcs);
  set('coinsurance', field_(num_(g_(coins, 'percent')), coins, g_(coins, 'service.definition')));

  var dedTotal = pick_(b.deductible, stcs, { allowFallback: true, timePeriods: TOTAL_PERIODS_ });
  var dedRem = pick_(b.deductible, stcs, { allowFallback: true, timePeriods: ['REMAINING'] });
  set('deductible_total', field_(num_(g_(dedTotal, 'amount')), dedTotal, g_(dedTotal, 'timePeriod')));
  set('deductible_remaining', field_(num_(g_(dedRem, 'amount')), dedRem));
  var oopTotal = pick_(b.outOfPocket, stcs, { allowFallback: true, timePeriods: TOTAL_PERIODS_ });
  var oopRem = pick_(b.outOfPocket, stcs, { allowFallback: true, timePeriods: ['REMAINING'] });
  set('oop_max_total', field_(num_(g_(oopTotal, 'amount')), oopTotal, g_(oopTotal, 'timePeriod')));
  set('oop_remaining', field_(num_(g_(oopRem, 'amount')), oopRem));

  // Visit limits: key name in the new shape is unconfirmed — scan any "limit"-like key.
  var limitEntries = [];
  Object.keys(b).forEach(function (k) { if (/limit/i.test(k)) limitEntries = limitEntries.concat(b[k]); });
  var limit = pick_(limitEntries, stcs);
  var qty = limit && (limit.quantity || limit.benefitQuantity);
  var qtyVal = qty && typeof qty === 'object' ? qty.value : qty;
  set('visit_limit', field_(qtyVal !== undefined ? qtyVal : g_(limit, 'amount'), limit, g_(limit, 'timePeriod')));

  var all = [];
  Object.keys(b).forEach(function (k) { all = all.concat(b[k]); });
  var authEntry = all.filter(function (e) { return inList_(stcs, stcOf_(e)) && e.priorAuthIndicator; })[0];
  set('prior_auth_required', field_(authEntry ? authEntry.priorAuthIndicator === 'REQUIRED' : undefined, authEntry, g_(authEntry, 'priorAuthIndicator')));

  var vendor = (b.contactFollowingEntityForInformation || []).filter(function (e) { return inList_(stcs, stcOf_(e)); })[0];
  if (vendor) {
    set('carve_out_vendor', field_((vendor.relatedEntities || []).map(function (r) { return g_(r, 'name.organization'); }).filter(Boolean).join(', '), vendor));
  }

  var msgs = [];
  all.forEach(function (e) {
    if (inList_(stcs, stcOf_(e))) (e.messages || []).forEach(function (m) { if (msgs.indexOf(m) === -1) msgs.push(m); });
  });
  if (msgs.length) set('payer_messages', field_(msgs));

  var gaps = FIELD_KEYS.required.filter(function (k) { return !(k in fields); });
  return nResult_(gaps.length ? 'gaps' : 'complete', { errors: errors, fields: fields, gaps: gaps, carveOut: !!vendor });
}

function mergeBenefits_(plans) {
  var out = {};
  plans.forEach(function (p) {
    var ben = p.benefits || {};
    Object.keys(ben).forEach(function (k) {
      if (Array.isArray(ben[k])) out[k] = (out[k] || []).concat(ben[k]);
    });
  });
  return out;
}

function nResult_(outcome, o) {
  return { outcome: outcome, errors: o.errors || [], fields: o.fields || {},
           gaps: o.gaps || FIELD_KEYS.required.slice(), carveOut: !!o.carveOut };
}

/** Plain-language one-liner for the UI / chart note. */
function plainSummary(n) {
  var f = function (k) { return n.fields[k] ? n.fields[k].value : undefined; };
  var money = function (v) { return v === undefined ? '?' : '$' + Number(v).toLocaleString('en-US'); };
  var descs = n.errors.map(function (e) { return e.description; }).join('; ');
  switch (n.outcome) {
    case 'inactive_coverage': return 'INACTIVE coverage' + (f('plan_name') ? ' (' + f('plan_name') + ')' : '') + '. Collect self-pay or new insurance.';
    case 'patient_data_error':
      return n.errors.some(function (e) { return e.code === '79'; })
        ? 'Payer ID or identifiers not recognized (AAA 79). Confirm which insurance company/plan is on the card.'
        : "Payer couldn't match the patient (" + descs + '). Re-check the insurance card.';
    case 'enrollment_error': return "Provider isn't registered with this payer for eligibility (" + n.errors.map(function (e) { return e.code; }).join(',') + ').';
    case 'retryable_error': return 'Payer system unavailable after retrying.';
    case 'unknown_error': return 'Check failed: ' + (descs || 'unknown error') + '.';
  }
  var parts = [
    'Active' + (f('plan_name') ? ' – ' + f('plan_name') : ''),
    f('network_status') ? 'network: ' + String(f('network_status')).replace(/_/g, ' ').toLowerCase() : null,
    'copay ' + money(f('copay')),
    f('coinsurance') !== undefined ? 'coinsurance ' + f('coinsurance') + '%' : null,
    'deductible ' + money(f('deductible_remaining')) + ' remaining of ' + money(f('deductible_total')),
    f('visit_limit') !== undefined ? 'visit limit ' + f('visit_limit') + (f('visits_used') !== undefined ? ' (' + f('visits_used') + ' used)' : '') : null,
    f('prior_auth_required') === true ? 'PRIOR AUTH REQUIRED' : (f('prior_auth_required') === false ? 'no prior auth' : null),
    f('carve_out_vendor') ? 'benefits managed by ' + f('carve_out_vendor') : null
  ].filter(Boolean);
  return parts.join(' · ') + (n.gaps.length ? ' · still verifying: ' + n.gaps.join(', ') : '');
}
