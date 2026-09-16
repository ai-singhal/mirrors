import type { ObservationStore } from './database.js';
export type HealthOptions = {
  baseline?: string;
  version?: string;
  days?: number;
  minRuns?: number;
  delta?: number;
  intent?: string;
  segment?: string;
  now?: number;
};
export function signalSummary(store: ObservationStore, days = 30, now = Date.now()) {
  const cutoff = new Date(now - days * 86400000).toISOString();
  return store
    .signals()
    .map((s) => {
      const totals = store.db
        .prepare(
          `SELECT COUNT(*) AS total_runs,SUM(sr.assessable) AS assessed,SUM(CASE WHEN sr.assessable=1 THEN sr.hit ELSE 0 END) AS affected FROM signal_results sr JOIN runs r ON r.id=sr.run_id WHERE sr.signal_id=? AND r.started_at>=? AND r.started_at<=?`,
        )
        .get(s.id, cutoff, new Date(now).toISOString()) as any;
      const labels = store.db
        .prepare(
          `SELECT COUNT(*) AS samples,SUM(l.agree) AS agreed,SUM(CASE WHEN h.run_id IS NOT NULL THEN 1 ELSE 0 END) AS positive_samples,SUM(CASE WHEN h.run_id IS NULL THEN 1 ELSE 0 END) AS negative_samples,SUM(CASE WHEN h.run_id IS NOT NULL AND l.agree=1 THEN 1 ELSE 0 END) AS true_positives FROM labels l LEFT JOIN signal_hits h ON h.signal_id=l.signal_id AND h.run_id=l.run_id AND h.step_idx=l.step_idx WHERE l.signal_id=?`,
        )
        .get(s.id) as any;
      const intents = store.db
        .prepare(
          `SELECT r.intent,r.segment,COUNT(*) AS assessed,SUM(sr.hit) AS affected FROM signal_results sr JOIN runs r ON r.id=sr.run_id WHERE sr.signal_id=? AND sr.assessable=1 AND r.started_at>=? AND r.started_at<=? GROUP BY r.intent,r.segment ORDER BY affected DESC`,
        )
        .all(s.id, cutoff, new Date(now).toISOString());
      const examples = store.db
        .prepare(
          `SELECT h.run_id,h.step_idx,h.reason,r.intent,r.segment FROM signal_hits h JOIN runs r ON r.id=h.run_id WHERE h.signal_id=? AND r.started_at>=? AND r.started_at<=? ORDER BY r.started_at DESC LIMIT 5`,
        )
        .all(s.id, cutoff, new Date(now).toISOString());
      return {
        ...s,
        ...totals,
        coverage: totals.total_runs ? totals.assessed / totals.total_runs : 0,
        rate: totals.assessed ? totals.affected / totals.assessed : null,
        labels: {
          ...labels,
          agreement: labels.samples ? labels.agreed / labels.samples : null,
          precision: labels.positive_samples
            ? labels.true_positives / labels.positive_samples
            : null,
          reviewed: labels.positive_samples > 0 && labels.negative_samples > 0,
        },
        intents,
        examples,
      };
    })
    .sort((a, b) => (b.affected ?? 0) - (a.affected ?? 0));
}
export function releaseHealth(store: ObservationStore, o: HealthOptions = {}) {
  const versions = store.versions() as any[];
  if (
    (o.version && !versions.some((v) => v.id === o.version)) ||
    (o.baseline && !versions.some((v) => v.id === o.baseline))
  )
    throw Error('Unknown version ID');
  const known = versions.filter((v) => v.known);
  const current = versions.find((v) => v.id === o.version) ?? known[0];
  const baseline =
    versions.find((v) => v.id === o.baseline) ??
    known.find((v) => v.id !== current?.id && v.deployed_at <= current.deployed_at);
  if (!current || !baseline || !current.known || !baseline.known || current.id === baseline.id)
    return {
      version: current?.id ?? null,
      baseline: baseline?.id ?? null,
      rows: [],
      regressions: 0,
      reason:
        'Two distinct tagged versions are required. Import version metadata or use ingest --version.',
    };
  const now = o.now ?? Date.now(),
    days = o.days ?? 30,
    minRuns = o.minRuns ?? 30,
    delta = o.delta ?? 0.05;
  if (
    !Number.isFinite(days) ||
    days <= 0 ||
    !Number.isInteger(minRuns) ||
    minRuns < 1 ||
    !Number.isFinite(delta) ||
    delta < 0 ||
    delta > 1
  )
    throw Error('Invalid health window or threshold');
  const windowStart = new Date(now - days * 86400000).toISOString();
  const end = new Date(now).toISOString();
  const rows = store.db
    .prepare(
      `SELECT sr.signal_id,r.intent,r.segment,r.version,COUNT(*) AS n,SUM(sr.hit) AS failures FROM signal_results sr JOIN runs r ON r.id=sr.run_id WHERE sr.assessable=1 AND r.completed=1 AND r.version IN (?,?) AND r.started_at>=? AND r.started_at<=? GROUP BY sr.signal_id,r.intent,r.segment,r.version`,
    )
    .all(baseline.id, current.id, windowStart, end) as any[];
  const groups = new Map<
    string,
    { signal_id: string; intent: string; segment: string; before: any; after: any }
  >();
  for (const row of rows) {
    if ((o.intent && o.intent !== row.intent) || (o.segment && o.segment !== row.segment)) continue;
    const key = JSON.stringify([row.signal_id, row.intent, row.segment]);
    const group = groups.get(key) ?? {
      signal_id: row.signal_id,
      intent: row.intent,
      segment: row.segment,
      before: null,
      after: null,
    };
    group[row.version === baseline.id ? 'before' : 'after'] = row;
    groups.set(key, group);
  }
  const comparisons = [...groups.values()]
    .map((g) => {
      const before = g.before?.n ? g.before.failures / g.before.n : null,
        after = g.after?.n ? g.after.failures / g.after.n : null;
      const enough = (g.before?.n ?? 0) >= minRuns && (g.after?.n ?? 0) >= minRuns;
      const change = before !== null && after !== null ? after - before : null;
      const verdict = !enough
        ? 'insufficient'
        : change! > delta
          ? 'regression'
          : change! < -delta
            ? 'improved'
            : 'stable';
      const worst = store.db
        .prepare(
          `SELECT h.run_id,COUNT(*) AS hit_steps,MAX(h.reason) AS reason FROM signal_hits h JOIN runs r ON r.id=h.run_id WHERE h.signal_id=? AND r.version=? AND r.intent=? AND r.segment=? AND r.started_at>=? AND r.started_at<=? GROUP BY h.run_id ORDER BY hit_steps DESC LIMIT 5`,
        )
        .all(g.signal_id, current.id, g.intent, g.segment, windowStart, end);
      return {
        signal_id: g.signal_id,
        intent: g.intent,
        segment: g.segment,
        before_rate: before,
        after_rate: after,
        delta: change,
        n_before: g.before?.n ?? 0,
        n_after: g.after?.n ?? 0,
        verdict,
        worst,
      };
    })
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  return {
    version: current.id,
    baseline: baseline.id,
    window_start: windowStart,
    window_end: end,
    min_runs: minRuns,
    delta_threshold: delta,
    rows: comparisons,
    regressions: comparisons.filter((r) => r.verdict === 'regression').length,
    reason:
      'Within-intent and segment observational comparison. Shared deploys and model changes can confound attribution; no significance claim.',
    model_changed: current.model !== baseline.model,
  };
}
export function fixResults(store: ObservationStore, id: string, options: HealthOptions = {}) {
  const fix = store.fixes().find((f) => f.id === id);
  if (!fix) throw Error('Unknown fix');
  if (!fix.version_id)
    return { fix, rows: [], reason: 'Fix has not been linked to a shipped version' };
  const version = store.versions().find((v: any) => v.id === fix.version_id) as any;
  if (fix.model && version?.model !== fix.model)
    return {
      fix,
      rows: [],
      reason: 'Pinned model does not match this release; use a version with the pinned model.',
    };
  const health = releaseHealth(store, {
    ...options,
    version: fix.version_id,
    baseline: fix.baseline_version ?? undefined,
  });
  const rows = health.rows.filter((r) => r.signal_id === fix.target_signal_id);
  const window = JSON.stringify({
    days: options.days ?? 30,
    baseline: health.baseline,
    version: health.version,
  });
  const write = store.db.prepare('INSERT OR REPLACE INTO fix_results VALUES(?,?,?,?,?,?,?,?)');
  for (const r of rows)
    write.run(id, r.intent, r.segment, r.before_rate, r.after_rate, r.n_before, r.n_after, window);
  const shared = store.fixes().filter((f) => f.version_id === fix.version_id && f.id !== id).length;
  return {
    fix,
    rows,
    shared_deploy: shared > 0,
    co_shipped_fixes: shared,
    reason: shared
      ? 'Several fixes share this deploy; these outcomes do not isolate an individual fix.'
      : health.reason,
  };
}
export function verifyFix(store: ObservationStore, id: string, options: HealthOptions = {}) {
  const result = fixResults(store, id, options);
  const signal = signalSummary(store, options.days ?? 30, options.now).find(
    (s) => s.id === result.fix.target_signal_id,
  );
  if (!signal?.labels.reviewed)
    throw Error('Label at least one positive and one negative sample before verification');
  if (result.fix.status !== 'shipped') throw Error('Only a shipped fix can be verified');
  if (
    !result.rows.length ||
    result.rows.some((r) => r.verdict === 'insufficient' || r.verdict === 'regression') ||
    !result.rows.some((r) => r.verdict === 'improved')
  )
    throw Error('Need sufficient per-segment outcomes, an improvement, and no observed regression');
  store.updateFix(id, { status: 'verified' });
  return {
    ...result,
    verified: true,
    notice: 'Observed improvement, not isolated causal attribution.',
  };
}
export function observationDigest(store: ObservationStore, options: HealthOptions = {}) {
  const signals = signalSummary(store, options.days ?? 7, options.now),
    health = releaseHealth(store, options),
    fixes = store.fixes();
  return [
    `Mirrors · last ${options.days ?? 7} days · ${store.runs(1_000_000).length} indexed runs`,
    `Top signals: ${signals
      .slice(0, 3)
      .map((s) => `${s.id} ${s.affected ?? 0}/${s.assessed ?? 0}`)
      .join('; ')}.`,
    `Release ${health.version ?? 'untagged'} vs ${health.baseline ?? 'missing'}: ${health.regressions} segment regressions${health.rows.length ? '' : '; insufficient version data'}.`,
    `${fixes.filter((f) => f.status === 'shipped').length} fixes awaiting verification; ${fixes.filter((f) => f.status === 'verified').length} verified by observed outcomes.`,
    `${signals.filter((s) => !s.labels.reviewed).length} signals still need positive and negative human labels.`,
  ].join('\n');
}
