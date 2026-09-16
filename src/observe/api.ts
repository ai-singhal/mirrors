import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { hash } from '../engine.js';
import type { ObservationStore } from './database.js';
import { fixSchema } from './schema.js';
import { registerFix, observationState, ingestRuns, importPromptFixes } from './service.js';
import { normalizeRuns } from './normalize.js';
import { releaseHealth, verifyFix } from './health.js';
import { nameIntent } from './intents.js';
const id = z.string().min(1).max(200);
export async function observationApi(
  db: ObservationStore,
  method: string,
  path: string,
  query: URLSearchParams,
  body: any,
) {
  const days = z.coerce
    .number()
    .positive()
    .max(3650)
    .parse(query.get('days') ?? 30);
  if (path === '/state' && method === 'GET') return observationState(db, days);
  if (path === '/health' && method === 'GET')
    return releaseHealth(db, {
      days,
      version: query.get('version') ?? undefined,
      baseline: query.get('baseline') ?? undefined,
      minRuns: z.coerce
        .number()
        .int()
        .positive()
        .parse(query.get('min_runs') ?? 30),
    });
  if (path === '/runs' && method === 'GET') return db.runs();
  if (path.startsWith('/runs/') && method === 'GET') {
    const run = db.run(decodeURIComponent(path.slice(6)));
    return {
      run,
      hits: db.db.prepare('SELECT * FROM signal_hits WHERE run_id=?').all(run.id),
      assessments: db.db.prepare('SELECT * FROM signal_results WHERE run_id=?').all(run.id),
      labels: db.db.prepare('SELECT * FROM labels WHERE run_id=?').all(run.id),
    };
  }
  if (path === '/ingest' && method === 'POST')
    return ingestRuns(db, normalizeRuns(body, 'local-ui'));
  if (path === '/labels' && method === 'POST') {
    const b = z
      .object({
        signal_id: id,
        run_id: id,
        step_idx: z.number().int().min(-1),
        agree: z.boolean(),
        by: z.string().default('local-ui'),
      })
      .parse(body);
    return db.label(b.signal_id, b.run_id, b.step_idx, b.agree, b.by);
  }
  if (path === '/fixes' && method === 'POST') {
    const b = fixSchema.omit({ id: true, created_at: true }).parse(body);
    return registerFix(db, { ...b, id: 'fix-' + hash(b.name + randomUUID()).slice(0, 10) });
  }
  if (path.startsWith('/fixes/') && method === 'PATCH') {
    const fixId = decodeURIComponent(path.slice(7));
    const b = z
      .object({
        status: z.enum(['proposed', 'shipped', 'verified', 'retired']).optional(),
        version_id: id.nullable().optional(),
        baseline_version: id.nullable().optional(),
        model: id.nullable().optional(),
        notes: z.string().optional(),
      })
      .strict()
      .parse(body);
    if (b.status === 'verified') return verifyFix(db, fixId, { days });
    if (
      b.status === 'shipped' &&
      !b.version_id &&
      !db.fixes().find((f) => f.id === fixId)?.version_id
    )
      throw Error('Choose the shipped version first');
    return db.updateFix(fixId, b);
  }
  if (path === '/intents/name' && method === 'POST') {
    const b = z.object({ id, name: z.string() }).parse(body);
    nameIntent(db, b.id, b.name);
    return { ok: true };
  }
  if (path === '/import-prompt' && method === 'POST') {
    const b = z.object({ text: z.string().min(1), signal: id }).parse(body);
    return importPromptFixes(db, b.text, 'local-ui', b.signal);
  }
  throw Error('Unknown observation endpoint');
}
