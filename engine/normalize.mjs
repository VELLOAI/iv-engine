// Turns a Stedi 271 (2026-06-01 JSON shape) into:
//   - normalized benefit fields for one specialty profile
//   - a gap list (required fields Stedi didn't answer)
//   - an outcome that the router uses to pick the next stage
//
// Field values carry their evidence (the Stedi message text) so the UI can show
// why a value is what it is.

export const PROFILE_STCS = {
  chiro: ['33'],
  physical_therapy: ['PT'],
  behavioral_health: ['MH', 'A6', 'A7', 'A8'],   // first one the payer answers wins
  office_visit_specialist: ['96', '98'],
};

// Required = the verification isn't complete without it.
// Optional = shown when present; never triggers escalation by itself.
export const FIELD_KEYS = {
  required: [
    'coverage_active', 'plan_name', 'network_status',
    'copay', 'coinsurance',
    'deductible_total', 'deductible_remaining',
    'oop_max_total', 'oop_remaining',
    'visit_limit', 'prior_auth_required',
  ],
  optional: ['group_number', 'plan_start', 'visits_used', 'carve_out_vendor', 'payer_messages',
             'insurance_type', 'coverage_limit_amount', 'covered_amount'],
};

const AAA_CLASS = {
  retryable: new Set(['42']),
  payerId: new Set(['79']),           // wrong payer ID or unidentifiable participant (HTTP 400)
  patientData: new Set(['15', '58', '60', '62', '64', '65', '67', '71', '72', '73', '75', '76', '77']),
  enrollment: new Set(['41', '43', '44', '45', '46', '47', '50', '51', '52', '56']),
};

const NETWORK_PREF = ['IN_NETWORK', 'IN_AND_OUT_OF_NETWORK', 'NOT_APPLICABLE', undefined];
const LEVEL_PREF = ['INDIVIDUAL', 'EMPLOYEE', undefined, 'FAMILY'];

const stcOf = (e) => (e?.service?.system === 'STC' ? e.service.value : undefined);
const rank = (arr, v) => { const i = arr.indexOf(v); return i === -1 ? arr.length : i; };

/** Best entry for the target STCs (falls back to STC 30 if allowFallback). */
function pick(entries = [], stcs, { allowFallback = false, timePeriods } = {}) {
  let pool = entries.filter((e) => stcs.includes(stcOf(e)));
  if (!pool.length && allowFallback) pool = entries.filter((e) => stcOf(e) === '30');
  if (timePeriods) pool = pool.filter((e) => timePeriods.includes(e.timePeriod));
  if (!pool.length) return undefined;
  return [...pool].sort((a, b) =>
    rank(NETWORK_PREF, a.network?.indicator) - rank(NETWORK_PREF, b.network?.indicator) ||
    rank(LEVEL_PREF, a.coverageLevel) - rank(LEVEL_PREF, b.coverageLevel) ||
    stcs.indexOf(stcOf(a)) - stcs.indexOf(stcOf(b))
  )[0];
}

const field = (value, entry, note) =>
  value === undefined || value === null ? undefined
    : { value, source: 'stedi', evidence: [note, ...(entry?.messages ?? [])].filter(Boolean).join(' | ') || undefined };

export function normalizeStediResponse(resp, { profile = 'chiro', serviceCodes } = {}) {
  const body = resp?.body ?? resp;            // accept either client result or raw body
  const httpStatus = resp?.httpStatus ?? 200;
  const stcs = serviceCodes ?? PROFILE_STCS[profile] ?? ['30'];
  const errors = (body?.errors ?? []).map((e) => ({ code: String(e.code), description: e.description, followupAction: e.followupAction }));
  const codes = errors.map((e) => e.code);

  // ── 1. errors before benefits ──
  if (httpStatus === 0 || httpStatus === 429 || httpStatus >= 500 || codes.some((c) => AAA_CLASS.retryable.has(c))) {
    return result('retryable_error', { errors });
  }
  if (codes.some((c) => AAA_CLASS.enrollment.has(c))) return result('enrollment_error', { errors });
  if (codes.some((c) => AAA_CLASS.patientData.has(c) || AAA_CLASS.payerId.has(c))) return result('patient_data_error', { errors });
  if (httpStatus >= 400 || (errors.length && !body?.plans?.length)) return result('unknown_error', { errors });

  // ── 2. benefits ──
  const plans = body?.plans ?? [];
  const b = mergeBenefits(plans);
  const fields = {};
  const set = (k, v) => { if (v) fields[k] = v; };

  const planStatus = pick(b.statuses, ['30']);
  if (planStatus) set('coverage_active', field(planStatus.status === 'ACTIVE_COVERAGE', planStatus, planStatus.status));
  set('plan_name', field(plans.find((p) => p.name)?.name ?? planStatus?.planCoverageDescription, planStatus));
  set('group_number', field(body?.subscriber?.additionalInformation?.group?.number));
  set('plan_start', field(body?.subscriber?.dates?.plan?.start));
  set('insurance_type', field(planStatus?.insuranceType));

  if (fields.coverage_active && fields.coverage_active.value === false) {
    return result('inactive_coverage', { errors, fields, gaps: [] });
  }

  const svcStatus = pick(b.statuses, stcs);
  set('network_status', field(svcStatus?.network?.indicator, svcStatus, svcStatus?.service?.definition));

  const copay = pick(b.coPayment, stcs);
  set('copay', field(copay?.amount != null ? Number(copay.amount) : undefined, copay, `${copay?.timePeriod ?? ''} ${copay?.service?.definition ?? ''}`.trim()));
  const coins = pick(b.coInsurance, stcs);
  set('coinsurance', field(coins?.percent != null ? Number(coins.percent) : undefined, coins, coins?.service?.definition));

  const TOTAL = ['CALENDAR_YEAR', 'SERVICE_YEAR', 'CONTRACT', 'YEAR_TO_DATE', 'LIFETIME', 'EPISODE'];
  const dedTotal = pick(b.deductible, stcs, { allowFallback: true, timePeriods: TOTAL });
  const dedRem = pick(b.deductible, stcs, { allowFallback: true, timePeriods: ['REMAINING'] });
  set('deductible_total', field(dedTotal && Number(dedTotal.amount), dedTotal, dedTotal?.timePeriod));
  set('deductible_remaining', field(dedRem && Number(dedRem.amount), dedRem));
  const oopTotal = pick(b.outOfPocket, stcs, { allowFallback: true, timePeriods: TOTAL });
  const oopRem = pick(b.outOfPocket, stcs, { allowFallback: true, timePeriods: ['REMAINING'] });
  set('oop_max_total', field(oopTotal && Number(oopTotal.amount), oopTotal, oopTotal?.timePeriod));
  set('oop_remaining', field(oopRem && Number(oopRem.amount), oopRem));

  // Visit limits: key name in the new shape is unconfirmed — scan any "limitation"-like key.
  const limitEntries = Object.entries(b).filter(([k]) => /limit/i.test(k)).flatMap(([, v]) => v);
  const limit = pick(limitEntries, stcs);
  const qty = limit?.quantity ?? limit?.benefitQuantity;
  set('visit_limit', field(qty?.value ?? qty ?? limit?.amount, limit, limit?.timePeriod));

  // Prior auth: any entry for the target service that carries the indicator.
  const authEntry = Object.values(b).flat().find((e) => stcs.includes(stcOf(e)) && e.priorAuthIndicator);
  set('prior_auth_required', field(authEntry && authEntry.priorAuthIndicator === 'REQUIRED', authEntry, authEntry?.priorAuthIndicator));

  // Carve-outs: payer says "contact this other entity" for our service.
  const vendor = (b.contactFollowingEntityForInformation ?? []).find((e) => stcs.includes(stcOf(e)));
  if (vendor) set('carve_out_vendor', field(vendor.relatedEntities?.map((r) => r.name?.organization).filter(Boolean).join(', '), vendor));

  const msgs = [...new Set(Object.values(b).flat().filter((e) => stcs.includes(stcOf(e))).flatMap((e) => e.messages ?? []))];
  if (msgs.length) set('payer_messages', field(msgs));

  const gaps = FIELD_KEYS.required.filter((k) => !(k in fields));
  // A carve-out means the payer itself won't have the specialty benefits: everything specialty-level is a gap.
  return result(gaps.length ? 'gaps' : 'complete', { errors, fields, gaps, carveOut: Boolean(vendor) });
}

function mergeBenefits(plans) {
  const out = {};
  for (const p of plans) for (const [k, v] of Object.entries(p.benefits ?? {})) {
    if (Array.isArray(v)) (out[k] ??= []).push(...v);
  }
  return out;
}

function result(outcome, { errors = [], fields = {}, gaps = FIELD_KEYS.required, carveOut = false }) {
  return { outcome, errors, fields, gaps, carveOut };
}

/** Plain-language one-liner for the UI / chart note. */
export function plainSummary(n) {
  const f = (k) => n.fields[k]?.value;
  const money = (v) => (v === undefined ? '?' : `$${v}`);
  switch (n.outcome) {
    case 'inactive_coverage': return `INACTIVE coverage${f('plan_name') ? ` (${f('plan_name')})` : ''}. Collect self-pay or new insurance.`;
    case 'patient_data_error': return n.errors.some((e) => e.code === '79')
      ? 'Payer ID or identifiers not recognized (AAA 79). Confirm which insurance company/plan is on the card.'
      : `Payer couldn't match the patient (${n.errors.map((e) => e.description).join('; ')}). Re-check the insurance card.`;
    case 'enrollment_error': return `Provider isn't registered with this payer for eligibility (${n.errors.map((e) => e.code).join(',')}).`;
    case 'retryable_error': return 'Payer system unavailable. Retrying.';
    case 'unknown_error': return `Check failed: ${n.errors.map((e) => e.description).join('; ') || 'unknown error'}.`;
  }
  const parts = [
    `Active${f('plan_name') ? ` – ${f('plan_name')}` : ''}`,
    f('network_status') && `network: ${f('network_status').replaceAll('_', ' ').toLowerCase()}`,
    `copay ${money(f('copay'))}`,
    f('coinsurance') !== undefined && `coinsurance ${f('coinsurance')}%`,
    `deductible ${money(f('deductible_remaining'))} remaining of ${money(f('deductible_total'))}`,
    f('visit_limit') !== undefined && `visit limit ${f('visit_limit')}`,
    f('prior_auth_required') === true && 'PRIOR AUTH REQUIRED',
    f('carve_out_vendor') && `benefits managed by ${f('carve_out_vendor')}`,
  ].filter(Boolean);
  return parts.join(' · ') + (n.gaps.length ? ` · still verifying: ${n.gaps.join(', ')}` : '');
}
