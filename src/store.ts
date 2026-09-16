import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import {
  ledgerSchema,
  type Ledger,
  type LogEvent,
  type Decision,
  type Context,
  type Trace,
} from './schema.js';
import { hash, ruleVersion } from './engine.js';
export class Store {
  readonly root: string;
  readonly state: string;
  readonly path: string;
  constructor(root = process.cwd()) {
    this.root = resolve(root);
    this.path = join(this.root, 'mirrors.yaml');
    this.state = join(this.root, '.mirrors');
  }
  init(ledger: Ledger) {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.path, stringify(ledgerSchema.parse(ledger)), { flag: 'wx' });
    this.ensure();
  }
  ensure() {
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
  }
  read() {
    return ledgerSchema.parse(
      parseDocument(readFileSync(this.path, 'utf8')).toJS({ maxAliasCount: 0 }),
    );
  }
  revision() {
    return hash(readFileSync(this.path, 'utf8'));
  }
  update(change: (v: Ledger) => Ledger, expected?: string, actor = 'local') {
    this.ensure();
    const lock = this.path + '.lock';
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      throw new Error('Ledger is being edited; retry shortly.');
    }
    try {
      const before = readFileSync(this.path, 'utf8');
      if (expected && hash(before) !== expected)
        throw new Error('Ledger changed since you opened it. Refresh before saving.');
      const old = this.read();
      const next = ledgerSchema.parse(change(structuredClone(old)));
      const doc = parseDocument(before);
      doc.set('name', next.name);
      const oldIds = old.rules.map((r) => r.id),
        newIds = next.rules.map((r) => r.id);
      if (JSON.stringify(oldIds) === JSON.stringify(newIds)) {
        next.rules.forEach((r, i) => {
          for (const k of Object.keys(r)) {
            if (
              JSON.stringify(r[k as keyof typeof r]) !==
              JSON.stringify(old.rules[i][k as keyof typeof r])
            )
              doc.setIn(['rules', i, k], r[k as keyof typeof r]);
          }
        });
      } else doc.set('rules', next.rules);
      doc.set('budgets', next.budgets);
      const tmp = this.path + '.' + randomUUID() + '.tmp';
      writeFileSync(tmp, doc.toString());
      renameSync(tmp, this.path);
      this.append({
        type: 'audit',
        data: {
          actor,
          before_hash: hash(before),
          after_hash: this.revision(),
          changes: next.rules
            .filter((r, i) => JSON.stringify(r) !== JSON.stringify(old.rules[i]))
            .map((r) => ({ id: r.id, status: r.status })),
        },
      });
      return next;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  append(
    event: Omit<LogEvent, 'id' | 'timestamp'> & Partial<Pick<LogEvent, 'id' | 'timestamp'>>,
  ): LogEvent {
    this.ensure();
    const row = {
      ...event,
      id: event.id ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as LogEvent;
    appendFileSync(join(this.state, 'events.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    return row;
  }
  events(): LogEvent[] {
    const path = join(this.state, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogEvent];
        } catch {
          return [];
        }
      });
  }
  logDecision(ctx: Context, d: Decision, ledger: Ledger) {
    if (!d.evaluations.length) return;
    const versions = new Map(ledger.rules.map((r) => [r.id, ruleVersion(r)]));
    const timestamp = new Date().toISOString();
    const rows = d.evaluations.map((e) => ({
      id: randomUUID(),
      timestamp,
      type: 'evaluation',
      session_id: ctx.session_id,
      step: ctx.step,
      model: ctx.model,
      prompt_hash: ctx.prompt_hash,
      rule_version: versions.get(e.rule_id),
      ...e,
      latency_ms: d.latency_ms,
    }));
    this.ensure();
    appendFileSync(
      join(this.state, 'events.jsonl'),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
      { mode: 0o600 },
    );
  }
  traces(): Trace[] {
    const dir = join(this.state, 'traces');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .flatMap((n) => {
        try {
          return [JSON.parse(readFileSync(join(dir, n), 'utf8')) as Trace];
        } catch {
          return [];
        }
      });
  }
  saveTraces(traces: Trace[]) {
    this.ensure();
    const dir = join(this.state, 'traces');
    mkdirSync(dir, { recursive: true });
    for (const t of traces)
      writeFileSync(join(dir, hash(t.id) + '.json'), JSON.stringify(t), { mode: 0o600 });
  }
  synthetic() {
    return existsSync(join(this.state, 'synthetic'));
  }
}
