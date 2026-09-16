import { Store } from '../store.js';
import { existsSync } from 'node:fs';
import { fixSchema } from './schema.js';
import { draftRule } from '../discover.js';
import { hash } from '../engine.js';
import { importPrompt } from '../discover.js';
import type { ObservationStore } from './database.js';
import type { Run } from './schema.js';
import { clusterIntents } from './intents.js';
import { signalSummary, releaseHealth, fixResults, observationDigest } from './health.js';
export function ingestRuns(store: ObservationStore, runs: Run[]) {
  const start = Date.now();
  let imported = 0;
  const warnings: string[] = [];
  for (const run of runs) {
    try {
      store.ingest(run);
      imported++;
    } catch (e) {
      warnings.push(`Run ${run.id}: ${String(e)}`);
    }
  }
  const intents = clusterIntents(store);
  store.audit('ingest', { imported, elapsed_ms: Date.now() - start });
  return {
    imported,
    elapsed_ms: Date.now() - start,
    intents_assigned: intents.assigned,
    unversioned: runs.filter((r) => !r.version_known).length,
    undated: runs.filter((r) => r.started_at.startsWith('1970-')).length,
    warnings,
  };
}
export function importPromptFixes(
  store: ObservationStore,
  text: string,
  source: string,
  targetSignal: string,
) {
  if (!store.signals().some((s) => s.id === targetSignal))
    throw Error('Choose a known target signal');
  let added = 0;
  for (const rule of importPrompt(text, source)) {
    const id = 'prompt-' + hash(rule.actions).slice(0, 12);
    if (store.fixes().some((f) => f.id === id)) continue;
    store.addFix({
      id,
      name: rule.name,
      target_signal_id: targetSignal,
      type: 'prompt',
      status: 'proposed',
      source: `${source}:${rule.source.line}`,
      notes: rule.actions.map((a) => (a.type === 'inject' ? a.text : '')).join('\n'),
    });
    added++;
  }
  return {
    added,
    note: 'Target signal is a human-selected hypothesis; review each imported fix before shipping.',
  };
}
export function observationState(store: ObservationStore, days = 30) {
  store.syncRuntime(new Store(store.root));
  const signals = signalSummary(store, days),
    health = releaseHealth(store, { days });
  return {
    signals,
    health,
    versions: store.versions(),
    fixes: store.fixes().map((f) => ({ ...f, results: fixResults(store, f.id, { days }) })),
    runs: store.runs(),
    intents: store.db
      .prepare('SELECT id,name,count FROM intent_clusters ORDER BY count DESC')
      .all(),
    replays: store.db
      .prepare(
        'SELECT id,created_at,report_json FROM replay_reports ORDER BY created_at DESC LIMIT 20',
      )
      .all()
      .map((r: any) => JSON.parse(r.report_json)),
    total_runs: (store.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as any).n,
    days,
    digest: observationDigest(store, { days }),
    last_ingest:
      store.db
        .prepare(
          "SELECT at,data FROM audit WHERE kind IN ('ingest','documentdb-ingest') ORDER BY at DESC LIMIT 1",
        )
        .get() ?? null,
  };
}

export function registerFix(db: ObservationStore, input: unknown) {
  const fix = fixSchema.parse(input);
  if (!db.signals().some((s) => s.id === fix.target_signal_id))
    throw Error('Unknown target signal');
  if (fix.type !== 'rule') return db.addFix(fix);
  const store = new Store(db.root);
  if (!existsSync(store.path)) store.init({ version: 1, name: 'My agent', rules: [], budgets: [] });
  const rule = draftRule(fix.name, { kind: 'manual', ref: fix.id }, fix.model ?? undefined);
  db.db.exec('BEGIN IMMEDIATE');
  try {
    const added = db.addFix({ ...fix, rule_id: rule.id });
    store.update((v) => {
      if (!v.rules.some((r) => r.id === rule.id)) v.rules.push(rule);
      return v;
    });
    db.db
      .prepare('INSERT OR REPLACE INTO rules VALUES(?,?,?,?,?,?,?)')
      .run(
        fix.id,
        rule.id,
        JSON.stringify(rule.condition),
        JSON.stringify(rule.actions),
        rule.status,
        rule.rollout,
        rule.priority,
      );
    db.db.exec('COMMIT');
    return added;
  } catch (e) {
    db.db.exec('ROLLBACK');
    throw e;
  }
}
