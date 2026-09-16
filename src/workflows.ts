import { readFileSync } from 'node:fs';
import { hash } from './engine.js';
import { estimateTokens, propose } from './discover.js';
import type { Store } from './store.js';
import type { LogEvent } from './schema.js';

/** Only explicit user flags feed proposal drafts by default. */
export function flaggedProposals(store: Store, allErrors = false) {
  const flags = new Set(
    store
      .events()
      .filter((e) => e.type === 'audit' && e.data?.kind === 'failure_flag')
      .map((e) => e.session_id),
  );
  return propose(store.traces().filter((t) => allErrors || flags.has(t.id)));
}
export function flagFailure(store: Store, traceId: string, note: string) {
  if (!store.traces().some((t) => t.id === traceId)) throw new Error('Unknown imported trace');
  return store.append({ type: 'audit', session_id: traceId, data: { kind: 'failure_flag', note } });
}
export function reviewQueue(events: LogEvent[]) {
  const resolutions = new Map(
    events
      .filter((e) => e.type === 'audit' && e.data?.kind === 'human_review')
      .map((e) => [e.target_id, e]),
  );
  return events
    .filter(
      (e) =>
        e.type === 'evaluation' &&
        e.outcome === 'fire' &&
        e.actions?.some((a) => a.type === 'human'),
    )
    .map((e) => ({ ...e, review: resolutions.get(e.id)?.data?.decision ?? 'pending' }));
}
export function resolveReview(store: Store, id: string, decision: 'approved' | 'denied') {
  if (!reviewQueue(store.events()).some((e) => e.id === id))
    throw new Error('Unknown human review');
  return store.append({
    type: 'audit',
    target_id: id,
    data: {
      kind: 'human_review',
      decision,
      note: 'Recorded only. The host must decide whether and how to resume.',
    },
  });
}
export function recordPrompt(store: Store, path: string) {
  const text = readFileSync(path, 'utf8');
  return store.append({
    type: 'audit',
    data: {
      kind: 'prompt_snapshot',
      path,
      hash: hash(text),
      estimated_tokens: estimateTokens(text),
    },
  });
}
export function promptSavings(events: LogEvent[]) {
  const groups = new Map<string, LogEvent[]>();
  for (const e of events)
    if (e.type === 'audit' && e.data?.kind === 'prompt_snapshot') {
      const key = String(e.data.path);
      const rows = groups.get(key) ?? [];
      rows.push(e);
      groups.set(key, rows);
    }
  return [...groups.entries()].map(([path, rows]) => {
    const before = Number(rows[0].data!.estimated_tokens),
      after = Number(rows.at(-1)!.data!.estimated_tokens);
    return {
      path,
      before,
      after,
      saved_per_request: before - after,
      snapshots: rows.length,
      estimator: 'characters / 4; approximate, not billed tokens',
    };
  });
}
