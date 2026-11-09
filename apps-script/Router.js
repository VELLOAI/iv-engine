/**
 * Decides where a verification goes after each stage: stedi → browserbase → retell → human.
 * A stage is used only if the payer playbook supports it AND it's switched on in Script
 * Properties (BROWSERBASE_ENABLED / RETELL_ENABLED). Until then, gaps go to the human queue.
 */

var STAGES = ['stedi', 'browserbase', 'retell', 'human'];

function route(n, playbook, from) {
  from = from || 'stedi';
  switch (n.outcome) {
    case 'complete': return done_('complete', 'All required fields answered.');
    case 'inactive_coverage': return done_('inactive_coverage', 'Payer reports inactive coverage. Notify the practice now.');
    case 'patient_data_error':
      return { status: 'needs_practice_data', nextStage: 'human', gaps: n.gaps, reason: 'Patient identifiers or payer ID rejected by payer.' };
    case 'enrollment_error':
      return { status: 'needs_enrollment', nextStage: 'human', gaps: n.gaps, reason: 'Provider not registered with payer for eligibility. Credentialing/enrollment needed.' };
  }
  var gaps = n.gaps || [];
  var next = nextAvailable_(from, playbook);
  var why = n.outcome === 'gaps'
    ? 'Missing ' + gaps.length + ' field(s)' + (n.carveOut ? ' (carve-out vendor detected)' : '') + '.'
    : 'Stage ' + from + ' failed (' + n.outcome + ').';
  return { status: next === 'human' ? 'needs_human' : 'running', nextStage: next, gaps: gaps, reason: why + ' → ' + next };

  function done_(status, reason) { return { status: status, nextStage: null, gaps: [], reason: reason }; }
}

function nextAvailable_(from, pb) {
  var rest = STAGES.slice(STAGES.indexOf(from) + 1);
  for (var i = 0; i < rest.length; i++) {
    var s = rest[i];
    if (s === 'browserbase' && pb && pb.portal_automation_enabled && stageEnabled_('browserbase')) return s;
    if (s === 'retell' && pb && pb.voice_automation_enabled && pb.phone_number && stageEnabled_('retell')) return s;
    if (s === 'human') return s;
  }
  return 'human';
}
