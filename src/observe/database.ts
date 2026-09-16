import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, renameSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from '../engine.js';
import { builtInSignals, detect } from './signals.js';
import {
  runSchema,
  fixSchema,
  type Run,
  type Signal,
  type SignalResult,
  type Fix,
} from './schema.js';
export class ObservationStore {
  readonly db: DatabaseSync;
  readonly root: string;
  readonly raw: string;
  constructor(root = process.cwd()) {
    this.root = resolve(root);
    const state = join(this.root, '.mirrors');
    this.raw = join(state, 'runs');
    mkdirSync(this.raw, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(state, 'index.sqlite'));
    chmodSync(join(state, 'index.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,prompt_hash TEXT,code_ref TEXT,model TEXT,deployed_at TEXT,known INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,version TEXT NOT NULL REFERENCES versions(id),model TEXT,intent TEXT,segment TEXT,started_at TEXT,steps_json_path TEXT,completed INTEGER,step_count INTEGER,first_user_hash TEXT);
  CREATE INDEX IF NOT EXISTS runs_window ON runs(version,intent,segment,started_at);
  CREATE TABLE IF NOT EXISTS model_calls(run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,idx INTEGER,sys_hash TEXT,messages_hash TEXT,tools_hash TEXT,duration_ms REAL,metadata TEXT,PRIMARY KEY(run_id,idx));
  CREATE TABLE IF NOT EXISTS steps(run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,idx INTEGER,call_idx INTEGER,tool TEXT,args_hash TEXT,status TEXT,error_class TEXT,duration_ms REAL,sys_hash TEXT,messages_hash TEXT,tools_hash TEXT,PRIMARY KEY(run_id,idx,call_idx));
  CREATE TABLE IF NOT EXISTS signals(id TEXT PRIMARY KEY,name TEXT,definition_text TEXT,kind TEXT,threshold REAL,detector TEXT,config TEXT,labeled_sample_path TEXT);
  CREATE TABLE IF NOT EXISTS signal_results(signal_id TEXT REFERENCES signals(id),run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,assessable INTEGER,hit INTEGER,reason TEXT,PRIMARY KEY(signal_id,run_id));
  CREATE TABLE IF NOT EXISTS signal_hits(signal_id TEXT REFERENCES signals(id),run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,step_idx INTEGER,confidence REAL,reason TEXT,PRIMARY KEY(signal_id,run_id,step_idx));
  CREATE TABLE IF NOT EXISTS labels(signal_id TEXT REFERENCES signals(id),run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,step_idx INTEGER,agree INTEGER,by TEXT,at TEXT,PRIMARY KEY(signal_id,run_id,step_idx));
  CREATE TABLE IF NOT EXISTS fixes(id TEXT PRIMARY KEY,target_signal_id TEXT REFERENCES signals(id),type TEXT,version_id TEXT REFERENCES versions(id),baseline_version TEXT REFERENCES versions(id),model TEXT,status TEXT,notes TEXT,source TEXT,name TEXT,rule_id TEXT,created_at TEXT);
  CREATE TABLE IF NOT EXISTS fix_results(fix_id TEXT REFERENCES fixes(id),intent TEXT,segment TEXT,before_rate REAL,after_rate REAL,n_before INTEGER,n_after INTEGER,window TEXT,PRIMARY KEY(fix_id,intent,segment,window));
  CREATE TABLE IF NOT EXISTS rules(fix_id TEXT REFERENCES fixes(id),rule_id TEXT PRIMARY KEY,condition TEXT,action TEXT,status TEXT,rollout REAL,priority INTEGER);
  CREATE TABLE IF NOT EXISTS fires(rule_id TEXT,run_id TEXT,step_idx INTEGER,mode TEXT,reason TEXT,event_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS intent_clusters(id TEXT PRIMARY KEY,name TEXT,centroid TEXT,count INTEGER);
  CREATE TABLE IF NOT EXISTS replay_reports(id TEXT PRIMARY KEY,created_at TEXT,report_json TEXT);
  CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT,kind TEXT,data TEXT);`);
    const insert = this.db.prepare('INSERT OR IGNORE INTO signals VALUES(?,?,?,?,?,?,?,?)');
    for (const s of builtInSignals())
      insert.run(
        s.id,
        s.name,
        s.definition_text,
        s.kind,
        s.threshold,
        s.detector,
        JSON.stringify(s.config),
        s.labeled_sample_path,
      );
  }
  syncRuntime(store: import('../store.js').Store) {
    try {
      const ledger = store.read();
      const rules = this.db.prepare('INSERT OR REPLACE INTO rules VALUES(?,?,?,?,?,?,?)');
      for (const r of ledger.rules) {
        const f = this.fixes().find((f) => f.rule_id === r.id);
        rules.run(
          f?.id ?? null,
          r.id,
          JSON.stringify(r.condition),
          JSON.stringify(r.actions),
          r.status,
          r.rollout,
          r.priority,
        );
      }
      const fires = this.db.prepare('INSERT OR IGNORE INTO fires VALUES(?,?,?,?,?,?)');
      for (const e of store.events())
        if (e.type === 'evaluation' && e.matched && e.rule_id && e.session_id)
          fires.run(
            e.rule_id,
            e.session_id,
            e.step ?? 0,
            e.cohort ?? 'shadow',
            e.reason ?? '',
            e.id,
          );
    } catch {
      /* Optional runtime records must not block measurement. */
    }
  }
  close() {
    this.db.close();
  }
  signals(): Signal[] {
    return (this.db.prepare('SELECT * FROM signals ORDER BY id').all() as any[]).map((s) => ({
      ...s,
      config: JSON.parse(s.config),
    }));
  }
  saveSignal(s: Signal) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(s.id) ||
      !s.name ||
      !s.definition_text ||
      !['code', 'judgment'].includes(s.kind) ||
      !Number.isFinite(s.threshold) ||
      s.threshold < 0 ||
      s.threshold > 1
    )
      throw Error('Invalid signal');
    if (this.signals().some((x) => x.id === s.id))
      throw Error('Signal definitions are immutable: use a new ID to preserve sample alignment');
    this.db
      .prepare('INSERT INTO signals VALUES(?,?,?,?,?,?,?,?)')
      .run(
        s.id,
        s.name,
        s.definition_text,
        s.kind,
        s.threshold,
        s.detector,
        JSON.stringify(s.config),
        s.labeled_sample_path,
      );
    this.audit('signal-change', { id: s.id });
  }
  ingest(input: Run) {
    const run = runSchema.parse(input),
      path = join(this.raw, hash(run) + '.json');
    const tmp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify(run), { mode: 0o600 });
    renameSync(tmp, path);
    const existing = this.db
      .prepare('SELECT intent,steps_json_path FROM runs WHERE id=?')
      .get(run.id) as any;
    const indexedIntent =
      run.intent === 'unclassified' && existing?.intent ? existing.intent : run.intent;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) {
        const old = this.run(run.id);
        if (
          hash({ messages: old.messages, steps: old.steps }) !==
          hash({ messages: run.messages, steps: run.steps })
        ) {
          const labels = this.db.prepare('SELECT * FROM labels WHERE run_id=?').all(run.id);
          if (labels.length)
            this.audit('labels-invalidated', {
              run_id: run.id,
              reason: 'Run content changed',
              previous_labels: labels,
            });
          this.db.prepare('DELETE FROM labels WHERE run_id=?').run(run.id);
        }
      }

      this.db
        .prepare(
          "INSERT INTO versions VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET deployed_at=MIN(deployed_at,excluded.deployed_at),known=MAX(known,excluded.known),model=CASE WHEN model=excluded.model THEN model ELSE 'mixed' END",
        )
        .run(
          run.version,
          run.prompt_hash,
          run.code_ref,
          run.model,
          run.started_at,
          Number(run.version_known),
        );
      this.db
        .prepare(
          'INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,model=excluded.model,intent=excluded.intent,segment=excluded.segment,started_at=excluded.started_at,steps_json_path=excluded.steps_json_path,completed=excluded.completed,step_count=excluded.step_count,first_user_hash=excluded.first_user_hash',
        )
        .run(
          run.id,
          run.version,
          run.model,
          indexedIntent,
          run.segment,
          run.started_at,
          path,
          Number(run.completed),
          run.steps.length,
          hash(run.first_user_message),
        );
      this.db.prepare('DELETE FROM steps WHERE run_id=?').run(run.id);
      this.db.prepare('DELETE FROM model_calls WHERE run_id=?').run(run.id);
      const modelCall = this.db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?)');
      for (const step of run.steps)
        modelCall.run(
          run.id,
          step.idx,
          step.sys_hash,
          step.messages_hash,
          step.tools_hash,
          step.duration_ms,
          JSON.stringify(step.metadata ?? {}),
        );
      const st = this.db.prepare('INSERT INTO steps VALUES(?,?,?,?,?,?,?,?,?,?,?)');
      for (const s of run.steps)
        for (const [i, c] of s.tool_calls.entries())
          st.run(
            run.id,
            s.idx,
            i,
            c.name,
            c.args_hash,
            c.status,
            c.error_class,
            c.duration_ms,
            s.sys_hash,
            s.messages_hash,
            s.tools_hash,
          );
      for (const signal of this.signals()) this.score(signal.id, run.id, detect(signal, run));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return run.id;
  }
  score(signalId: string, runId: string, result: SignalResult) {
    this.db.prepare('DELETE FROM signal_hits WHERE signal_id=? AND run_id=?').run(signalId, runId);
    this.db
      .prepare('INSERT OR REPLACE INTO signal_results VALUES(?,?,?,?,?)')
      .run(
        signalId,
        runId,
        Number(result.assessable),
        Number(!!result.hits.length),
        result.reason ?? null,
      );
    const add = this.db.prepare('INSERT OR REPLACE INTO signal_hits VALUES(?,?,?,?,?)');
    for (const h of result.hits) add.run(signalId, runId, h.step_idx, h.confidence, h.reason);
  }
  run(id: string): Run {
    const row = this.db
      .prepare('SELECT steps_json_path,intent FROM runs WHERE id=?')
      .get(id) as any;
    if (!row) throw Error('Unknown run');
    return {
      ...runSchema.parse(JSON.parse(readFileSync(row.steps_json_path, 'utf8'))),
      intent: row.intent,
    };
  }
  runs(limit = 200) {
    return this.db
      .prepare(
        'SELECT r.id,r.version,r.model,r.intent,r.segment,r.started_at,r.completed,r.step_count,(SELECT COUNT(DISTINCT signal_id) FROM signal_hits WHERE run_id=r.id) AS signal_count FROM runs r ORDER BY r.started_at DESC LIMIT ?',
      )
      .all(limit);
  }
  versions() {
    return this.db
      .prepare(
        'SELECT v.*,COUNT(r.id) AS runs FROM versions v LEFT JOIN runs r ON r.version=v.id GROUP BY v.id ORDER BY v.deployed_at DESC',
      )
      .all();
  }
  label(signalId: string, runId: string, step: number, agree: boolean, by = 'local') {
    if (!this.signals().some((s) => s.id === signalId)) throw Error('Unknown signal');
    const run = this.run(runId);
    if (step < -1 || step >= run.steps.length) throw Error('Invalid step');
    this.db
      .prepare('INSERT OR REPLACE INTO labels VALUES(?,?,?,?,?,?)')
      .run(signalId, runId, step, Number(agree), by, new Date().toISOString());
    const path = join(this.root, '.mirrors', `labels-${signalId}.json`);
    const samples = this.db.prepare('SELECT * FROM labels WHERE signal_id=?').all(signalId);
    writeFileSync(path, JSON.stringify(samples, null, 2), { mode: 0o600 });
    this.db.prepare('UPDATE signals SET labeled_sample_path=? WHERE id=?').run(path, signalId);
    return { labeled: samples.length };
  }
  addFix(input: unknown) {
    const fix = fixSchema.parse(input);
    if (['shipped', 'verified'].includes(fix.status) && !fix.version_id)
      throw Error('A shipped or verified fix needs a version');
    this.db
      .prepare('INSERT INTO fixes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        fix.id,
        fix.target_signal_id,
        fix.type,
        fix.version_id,
        fix.baseline_version,
        fix.model,
        fix.status,
        fix.notes,
        fix.source,
        fix.name,
        fix.rule_id,
        fix.created_at,
      );
    this.audit('fix-created', fix);
    return fix;
  }
  fixes(): Fix[] {
    return this.db.prepare('SELECT * FROM fixes ORDER BY created_at DESC').all() as any;
  }
  updateFix(id: string, patch: Partial<Fix>) {
    const old = this.fixes().find((f) => f.id === id);
    if (!old) throw Error('Unknown fix');
    const f = fixSchema.parse({ ...old, ...patch, id });
    if (['shipped', 'verified'].includes(f.status) && !f.version_id)
      throw Error('A shipped or verified fix needs a version');
    this.db
      .prepare(
        'UPDATE fixes SET name=?,version_id=?,baseline_version=?,model=?,status=?,notes=?,rule_id=? WHERE id=?',
      )
      .run(f.name, f.version_id, f.baseline_version, f.model, f.status, f.notes, f.rule_id, id);
    this.audit('fix-updated', { id, patch });
    return f;
  }
  audit(kind: string, data: unknown) {
    this.db
      .prepare('INSERT INTO audit VALUES(?,?,?,?)')
      .run(randomUUID(), new Date().toISOString(), kind, JSON.stringify(data));
  }
}
