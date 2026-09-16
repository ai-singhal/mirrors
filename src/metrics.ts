import { promptSavings } from './workflows.js';
import { ruleVersion } from './engine.js';
import type { Rule, Ledger, LogEvent } from './schema.js';
export type RuleMetrics = ReturnType<typeof measureRule>;
export function measureRule(rule: Rule, all: LogEvent[], days = 30, now = Date.now()) {
  const cutoff = now - days * 86400000;
  const events = all.filter(
    (e) => Date.parse(e.timestamp) >= cutoff && Date.parse(e.timestamp) <= now,
  );
  const version = ruleVersion(rule);
  const own = events.filter((e) => e.rule_id === rule.id && e.rule_version === version);
  const evaluations = own.filter((e) => e.type === 'evaluation');
  const fires = evaluations.filter((e) => e.outcome === 'fire');
  const labels = new Map<string, LogEvent>();
  for (const e of events) if (e.type === 'label' && e.target_id) labels.set(e.target_id, e);
  const validLabels = fires.flatMap((f) => (labels.has(f.id) ? [labels.get(f.id)!] : []));
  const correct = validLabels.filter((e) => e.label === 'correct').length;
  const overrides = validLabels.filter((e) => e.label === 'override').length;
  // A run belongs to one cohort. Only terminal, explicitly observed rule outcomes enter recurrence.
  const outcomes = new Map<string, LogEvent>();
  for (const e of own)
    if (
      e.type === 'outcome' &&
      e.session_id &&
      typeof e.failure === 'boolean' &&
      ['treatment', 'control'].includes(e.cohort ?? '')
    )
      outcomes.set(e.session_id, e);
  const treatment = [...outcomes.values()].filter((e) => e.cohort === 'treatment');
  const control = [...outcomes.values()].filter((e) => e.cohort === 'control');
  const failures = (xs: LogEvent[]) => xs.filter((e) => e.failure).length;
  const tr = treatment.length ? (failures(treatment) / treatment.length) * 1000 : null,
    cr = control.length ? (failures(control) / control.length) * 1000 : null;
  const lift = tr !== null && cr !== null && cr > 0 ? (cr - tr) / cr : null;
  const matched = evaluations.filter((e) => e.matched);
  const assessed = evaluations.filter((e) => e.matched !== null && e.cohort !== 'none');
  const runs = new Set(assessed.map((e) => e.session_id)).size;
  let verdict: 'working' | 'not working' | 'dead weight' | 'cannot assess' = 'cannot assess';
  let explanation = 'Need completed treatment and control runs with a defined failure signal.';
  if (!matched.length && runs >= rule.expiry.min_runs) {
    verdict = 'dead weight';
    explanation = `No matching situation in ${runs} observed runs.`;
  } else if (
    rule.failure &&
    treatment.length >= rule.expiry.min_runs &&
    control.length >= rule.expiry.min_runs &&
    tr !== null &&
    cr !== null
  ) {
    const p1 = tr / 1000,
      p0 = cr / 1000,
      se = Math.sqrt((p1 * (1 - p1)) / treatment.length + (p0 * (1 - p0)) / control.length);
    const delta = p0 - p1;
    if (delta > 1.96 * se && delta > 0) {
      verdict = 'working';
      explanation = 'Lower observed recurrence; approximate 95% difference interval excludes zero.';
    } else if (delta < -1.96 * se) {
      verdict = 'not working';
      explanation =
        'Higher observed recurrence; approximate 95% difference interval excludes zero.';
    } else explanation = 'Enough runs to compare, but observed difference remains inconclusive.';
  }
  const latencies = evaluations.map((e) => e.latency_ms ?? 0).sort((a, b) => a - b);
  return {
    rule_id: rule.id,
    fires: fires.length,
    would_have_fired: evaluations.filter((e) => e.outcome === 'shadow').length,
    control_matches: evaluations.filter((e) => e.outcome === 'control').length,
    matched: matched.length,
    runs,
    occurrence_rate: assessed.length ? matched.length / assessed.length : null,
    precision: validLabels.length ? correct / validLabels.length : null,
    labels: validLabels.length,
    overrides,
    treatment_runs: treatment.length,
    control_runs: control.length,
    treatment_failures: failures(treatment),
    control_failures: failures(control),
    treatment_per_1k: tr,
    control_per_1k: cr,
    lift,
    verdict,
    explanation,
    p95_ms: latencies.length
      ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
      : null,
    last_match: matched.at(-1)?.timestamp ?? null,
  };
}
export function metrics(ledger: Ledger, events: LogEvent[], days = 30) {
  return ledger.rules.map((r) => measureRule(r, events, days));
}
export function budgetBreaches(ledger: Ledger, events: LogEvent[], days = 30) {
  const cutoff = Date.now() - days * 86400000;
  return ledger.budgets.flatMap((b) => {
    const runs = new Map<string, boolean>();
    for (const e of events)
      if (
        e.type === 'outcome' &&
        e.failure_class === b.failure_class &&
        e.session_id &&
        typeof e.failure === 'boolean' &&
        Date.parse(e.timestamp) >= cutoff
      )
        runs.set(e.session_id, (runs.get(e.session_id) ?? false) || e.failure);
    const failures = [...runs.values()].filter(Boolean).length;
    const rate = runs.size ? (failures / runs.size) * 1000 : null;
    return rate !== null && runs.size >= b.min_runs && rate > b.ceiling_per_1k
      ? [{ ...b, runs: runs.size, failures, recurrence_per_1k: rate }]
      : [];
  });
}
export function digest(ledger: Ledger, events: LogEvent[], days = 7) {
  const ms = metrics(ledger, events, days);
  const saved = promptSavings(events).reduce((sum, p) => sum + p.saved_per_request, 0);
  return [
    `Mirrors · ${ledger.name} · last ${days} days`,
    `${ms.reduce((n, m) => n + m.fires, 0)} interventions; ${ms.reduce((n, m) => n + m.would_have_fired, 0)} shadow matches.`,
    `Earned their keep: ${
      ms
        .filter((m) => m.verdict === 'working')
        .map((m) => m.rule_id)
        .join(', ') || 'no conclusive lift yet'
    }.`,
    `Review or remove: ${
      ms
        .filter((m) => ['dead weight', 'not working'].includes(m.verdict))
        .map((m) => m.rule_id)
        .join(', ') || 'none with sufficient evidence'
    }.`,
    `${budgetBreaches(ledger, events, days).length} behavior budgets breached; ${ms.filter((m) => m.verdict === 'cannot assess').length} rules need more evidence.${saved ? ' Prompt change: ' + (saved > 0 ? '-' : '+') + Math.abs(saved) + ' estimated tokens/request.' : ''}`,
  ].join('\n');
}
export function lifecycle(ledger: Ledger, events: LogEvent[], model?: string) {
  const changes: { id: string; status: Rule['status']; reason: string }[] = [];
  for (const r of ledger.rules) {
    if (!['active', 'shadow'].includes(r.status)) continue;
    const m = measureRule(
      r,
      events,
      Math.max(r.expiry.idle_days ?? 30, r.expiry.no_lift_days ?? 30),
    );
    if (model && r.pinned.model && model !== r.pinned.model && r.status === 'active') {
      changes.push({ id: r.id, status: 'shadow', reason: 'Model changed; earn activation again' });
      continue;
    }
    if (r.expiry.expires_at && Date.parse(r.expiry.expires_at) < Date.now())
      changes.push({ id: r.id, status: 'retired', reason: 'Expiry date passed' });
    else if (r.expiry.override_limit && m.overrides >= r.expiry.override_limit)
      changes.push({ id: r.id, status: 'retired', reason: 'Human override threshold reached' });
    else if (
      r.expiry.idle_days &&
      Date.now() - Date.parse(r.created_at) >= r.expiry.idle_days * 86400000 &&
      measureRule(r, events, r.expiry.idle_days).runs >= r.expiry.min_runs &&
      !measureRule(r, events, r.expiry.idle_days).matched
    )
      changes.push({ id: r.id, status: 'retired', reason: 'No matches within idle window' });
    else if (
      r.expiry.no_lift_days &&
      Date.now() - Date.parse(r.created_at) >= r.expiry.no_lift_days * 86400000 &&
      measureRule(r, events, r.expiry.no_lift_days).verdict === 'not working'
    )
      changes.push({ id: r.id, status: 'retired', reason: 'Evidence of worse recurrence' });
  }
  return changes;
}
