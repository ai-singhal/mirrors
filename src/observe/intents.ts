import { hash } from '../engine.js';
import type { ObservationStore } from './database.js';
import type { Run } from './schema.js';
/** Local feature-hash embedding. No text is sent to a provider. */
export function intentEmbedding(run: Run) {
  const text =
    run.first_user_message +
    ' ' +
    run.steps
      .flatMap((s) => s.tool_calls)
      .slice(0, 2)
      .map((c) => c.name + ' ' + Object.keys(c.args).join(' '))
      .join(' ');
  const vector = new Array<number>(128).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  for (const word of words) {
    const h = hash(word);
    vector[parseInt(h.slice(0, 4), 16) % vector.length] += parseInt(h.slice(4, 6), 16) % 2 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((s, n) => s + n * n, 0));
  return norm ? vector.map((v) => v / norm) : vector;
}
const cosine = (a: number[], b: number[]) => a.reduce((s, n, i) => s + n * b[i], 0);
export function clusterIntents(store: ObservationStore, threshold = 0.55) {
  if (threshold < 0 || threshold > 1) throw Error('Threshold must be 0–1');
  const clusters = (store.db.prepare('SELECT * FROM intent_clusters').all() as any[]).map((c) => ({
    ...c,
    centroid: JSON.parse(c.centroid),
  }));
  let assigned = 0;
  for (const row of store.runs(1_000_000) as any[]) {
    if (row.intent !== 'unclassified') continue;
    const run = store.run(row.id),
      vector = intentEmbedding(run);
    if (!vector.some(Boolean)) continue;
    let best = clusters
      .map((c) => ({ c, score: cosine(vector, c.centroid) }))
      .sort((a, b) => b.score - a.score)[0];
    let cluster = best && best.score >= threshold ? best.c : undefined;
    if (!cluster) {
      const id = 'intent-' + hash(vector).slice(0, 8);
      cluster = { id, name: id, centroid: vector, count: 0 };
      clusters.push(cluster);
    }
    cluster.count++;
    store.db
      .prepare(
        'INSERT INTO intent_clusters VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET count=excluded.count',
      )
      .run(cluster.id, cluster.name, JSON.stringify(cluster.centroid), cluster.count);
    store.db.prepare('UPDATE runs SET intent=? WHERE id=?').run(cluster.name, row.id);
    assigned++;
  }
  return {
    assigned,
    clusters: clusters.map((c) => ({ id: c.id, name: c.name, count: c.count })),
    method:
      'Local feature-hash embedding of first user message and first two tool names/argument keys. Human names required; not a semantic failure scorer.',
  };
}
export function nameIntent(store: ObservationStore, id: string, name: string) {
  if (!name.trim() || name.length > 100) throw Error('Use a name of 1–100 characters');
  const c = store.db.prepare('SELECT * FROM intent_clusters WHERE id=?').get(id) as any;
  if (!c) throw Error('Unknown intent cluster');
  store.db.exec('BEGIN');
  try {
    store.db.prepare('UPDATE runs SET intent=? WHERE intent=?').run(name, c.name);
    store.db.prepare('UPDATE intent_clusters SET name=? WHERE id=?').run(name, id);
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
  store.audit('intent-name', { id, name });
}
