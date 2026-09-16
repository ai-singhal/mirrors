import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import {
  flagFailure,
  flaggedProposals,
  reviewQueue,
  resolveReview,
  recordPrompt,
  promptSavings,
} from '../src/workflows';
import { normalizeExport } from '../src/discover';
import { Engine } from '../src/engine';
import { contextSchema, ruleSchema } from '../src/schema';
function store() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'mirrors-workflows-')));
  s.init({ version: 1, name: 'Test', rules: [], budgets: [] });
  return s;
}
it('only proposes human-flagged failures unless explicitly broadened', () => {
  const s = store();
  s.saveTraces([
    {
      id: 'x',
      model: 'm',
      timestamp: new Date().toISOString(),
      tools: [{ tool: 'write', args: {}, status: 'error', error: 'Not found' }],
    },
  ]);
  expect(flaggedProposals(s)).toEqual([]);
  expect(flaggedProposals(s, true)).toHaveLength(1);
  flagFailure(s, 'x', 'Wrong document');
  expect(flaggedProposals(s)[0].rule.status).toBe('shadow');
  expect(() => flagFailure(s, 'missing', 'bad')).toThrow();
});
it('resolves a human queue record without executing the blocked operation', () => {
  const s = store();
  const e = s.append({
    type: 'evaluation',
    outcome: 'fire',
    actions: [{ type: 'human', reason: 'Review' }],
  });
  expect(reviewQueue(s.events())[0].review).toBe('pending');
  resolveReview(s, e.id, 'approved');
  expect(reviewQueue(s.events())[0].review).toBe('approved');
});
it('tracks real prompt size changes without persisting prompt contents', () => {
  const s = store(),
    p = join(s.root, 'prompt.txt');
  writeFileSync(p, 'x'.repeat(400));
  recordPrompt(s, p);
  writeFileSync(p, 'x'.repeat(240));
  recordPrompt(s, p);
  expect(promptSavings(s.events())[0]).toMatchObject({
    before: 100,
    after: 60,
    saved_per_request: 40,
  });
  expect(JSON.stringify(s.events())).not.toContain('x'.repeat(20));
});
it('preserves Anthropic explicit tool error status', () => {
  const [t] = normalizeExport({
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'write', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'Missing document' },
        ],
      },
    ],
  });
  expect(t.tools[0].status).toBe('error');
});
it('does not judge or count a tool-only rule at a model hook', async () => {
  const r = ruleSchema.parse({
    id: 'review',
    name: 'Review',
    status: 'shadow',
    condition: { type: 'judgment', question: 'Risky?' },
    actions: [{ type: 'human', reason: 'Ask' }],
  });
  let called = false;
  const d = await new Engine({ version: 1, rules: [r] }).evaluateAsync(
    contextSchema.parse({ session_id: 's', model: 'm', step: 0 }),
    async () => {
      called = true;
      return { answer: true, confidence: 1 };
    },
  );
  expect(called).toBe(false);
  expect(d.evaluations[0]).toMatchObject({ matched: null, cohort: 'none', outcome: 'skipped' });
});
