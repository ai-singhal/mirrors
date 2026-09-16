import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.js';
import { starterLedger } from './packs.js';
import { Engine, cohort, ruleVersion } from './engine.js';
import { ruleSchema, type Context } from './schema.js';
export function createDemo(store: Store) {
  const ledger = starterLedger();
  ledger.name = 'Atlas · research agent';
  ledger.rules[0].status = 'active';
  ledger.rules[0].rollout = 50;
  ledger.rules[0].pinned.model = 'demo-model-v1';
  ledger.rules[0].created_at = new Date(Date.now() - 45 * 86400000).toISOString();
  ledger.rules.push(
    ruleSchema.parse({
      id: 'verify-delivery',
      name: 'Verify the file is ready to download',
      condition: {
        type: 'judgment',
        question:
          'Is the agent about to claim a file is downloadable without checking that a file exists?',
        confidence: 0.9,
      },
      actions: [
        { type: 'inject', text: 'Verify the exported file exists before promising a download.' },
      ],
      source: { kind: 'manual' },
      notes: 'Needs a configured judge and explicit outcome labels.',
    }),
  );
  ledger.rules.push(
    ruleSchema.parse({
      id: 'legacy-format-reminder',
      name: 'Use the legacy report template',
      condition: { type: 'code', when: { field: 'intent', op: 'eq', value: 'legacy-report' } },
      actions: [{ type: 'inject', text: 'Use the legacy template.' }],
      status: 'off',
      source: { kind: 'manual' },
      notes: 'Disabled after the reporting workflow changed.',
    }),
  );
  store.init(ledger);
  writeFileSync(
    join(store.state, 'synthetic'),
    'Synthetic demonstration data. Not production evidence.',
  );
  const engine = new Engine(ledger);
  for (let i = 0; i < 240; i++) {
    const session = 'demo-' + i;
    const ctx: Context = {
      session_id: session,
      step: 3,
      model: 'demo-model-v1',
      intent: 'research',
      phase: 'model',
      tools: ['doc_read', 'doc_write'],
      trajectory: [
        { tool: 'doc_write', args: { id: 'section-a' }, status: 'error', error: 'Invalid node ID' },
        { tool: 'doc_write', args: { id: 'section-a' }, status: 'error', error: 'Invalid node ID' },
      ],
    };
    const d = engine.evaluate(ctx);
    store.logDecision(ctx, d, ledger);
    const r = ledger.rules[0];
    const arm = cohort(r, session);
    store.append({
      type: 'outcome',
      session_id: session,
      model: ctx.model,
      rule_id: r.id,
      rule_version: ruleVersion(r),
      cohort: arm,
      failure: arm === 'treatment' ? i % 20 === 0 : i % 4 === 0,
      failure_class: r.failure!.class,
    });
    if (i < 10)
      store.saveTraces([
        {
          id: session,
          model: ctx.model,
          timestamp: new Date().toISOString(),
          intent: 'research',
          tools: [
            ...ctx.trajectory,
            {
              tool: 'doc_write',
              args: { id: 'section-a' },
              status: 'error',
              error: 'Invalid node ID',
            },
          ],
        },
      ]);
  }
  const fires = store.events().filter((e) => e.outcome === 'fire');
  for (const [i, e] of fires.slice(0, 32).entries())
    store.append({
      type: 'label',
      target_id: e.id,
      rule_id: e.rule_id,
      label: i === 0 ? 'override' : i === 1 ? 'incorrect' : 'correct',
    });
  return ledger;
}
