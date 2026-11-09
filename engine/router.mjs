// Decides where a verification goes after each stage.
// Waterfall: stedi → browserbase → retell → human.
// Playbook = a row from public.payer_playbooks (or null if we've never seen this payer).

export const STAGES = ['stedi', 'browserbase', 'retell', 'human'];

/**
 * @param {object} n         output of normalizeStediResponse (or the same shape from a later stage)
 * @param {object|null} pb   payer playbook
 * @param {string} from      stage that just ran
 * @returns {{ status: string, nextStage: string|null, gaps: string[], reason: string }}
 */
export function route(n, pb, from = 'stedi') {
  switch (n.outcome) {
    case 'complete':
      return done('complete', 'All required fields answered.');
    case 'inactive_coverage':
      return done('inactive_coverage', 'Payer reports inactive coverage. Notify the practice now.');
    case 'patient_data_error':
      // Portal and phone need the same identifiers, so escalating won't fix bad card data.
      return { status: 'needs_practice_data', nextStage: 'human', gaps: n.gaps, reason: 'Patient identifiers rejected by payer.' };
    case 'enrollment_error':
      return { status: 'needs_enrollment', nextStage: 'human', gaps: n.gaps, reason: 'Provider not registered with payer for eligibility. Credentialing/enrollment needed.' };
  }

  // retryable_error (after the client's 2-min retry window), unknown_error, or gaps → escalate.
  const gaps = n.gaps?.length ? n.gaps : [];
  const next = nextAvailable(from, pb);
  const why = n.outcome === 'gaps'
    ? `Missing ${gaps.length} field(s)${n.carveOut ? ' (carve-out vendor detected)' : ''}.`
    : `Stage ${from} failed (${n.outcome}).`;
  return { status: next === 'human' ? 'needs_human' : 'running', nextStage: next, gaps, reason: `${why} → ${next}` };

  function done(status, reason) { return { status, nextStage: null, gaps: [], reason }; }
}

function nextAvailable(from, pb) {
  for (const stage of STAGES.slice(STAGES.indexOf(from) + 1)) {
    if (stage === 'browserbase' && pb?.portal_automation_enabled) return stage;
    if (stage === 'retell' && pb?.voice_automation_enabled && pb?.phone_number) return stage;
    if (stage === 'human') return stage;
  }
  return 'human';
}
