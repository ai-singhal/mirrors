import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store';
import { Runtime } from '../src/runtime';
import { starterLedger } from '../src/packs';
import { ruleSchema, contextSchema } from '../src/schema';
import { ruleVersion } from '../src/engine';
import { measureRule, lifecycle } from '../src/metrics';
import { normalizeExport, backtest, importPrompt, propose } from '../src/discover';
const make = () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'mirrors-test-')));
  s.init(starterLedger());
  return s;
};
it('rejects lost updates and preserves YAML comments', () => {
  const s = make();
  appendFileSync(s.path, '# Keep this comment\n');
  const rev = s.revision();
  s.update((v) => {
    v.rules[0].status = 'active';
    return v;
  }, rev);
  expect(readFileSync(s.path, 'utf8')).toContain('# Keep this comment');
  expect(() => s.update((v) => v, rev)).toThrow('changed');
  expect(s.events().at(-1)?.type).toBe('audit');
});
it('rejects invalid YAML edits atomically', () => {
  const s = make();
  const before = readFileSync(s.path, 'utf8');
  expect(() =>
    s.update((v) => {
      v.rules[0].rollout = 200;
      return v;
    }),
  ).toThrow();
  expect(readFileSync(s.path, 'utf8')).toBe(before);
});
it('initialization never overwrites a ledger', () => {
  const s = make();
  expect(() => s.init(starterLedger())).toThrow();
});
it('survives a corrupt partial trailing event', () => {
  const s = make();
  s.append({ type: 'audit' });
  appendFileSync(join(s.state, 'events.jsonl'), '{bad');
  expect(s.events()).toHaveLength(1);
});
it('runtime with broken config is passive', async () => {
  const s = make();
  writeFileSync(s.path, 'invalid');
  const d = await new Runtime(s).evaluate(
    contextSchema.parse({ session_id: 'x', step: 0, model: 'm' }),
  );
  expect(d.blocked).toBe(false);
  expect(d.error).toBeTruthy();
});
it('human labels are event-specific and latest label wins', () => {
  const r = starterLedger().rules[0];
  const base = { timestamp: new Date().toISOString(), rule_id: r.id, rule_version: ruleVersion(r) };
  const events: any[] = [
    {
      ...base,
      id: 'f1',
      type: 'evaluation',
      outcome: 'fire',
      matched: true,
      session_id: 's',
      cohort: 'treatment',
    },
    { ...base, id: 'l1', type: 'label', target_id: 'f1', label: 'correct' },
    { ...base, id: 'l2', type: 'label', target_id: 'f1', label: 'override' },
  ];
  const m = measureRule(r, events);
  expect(m.precision).toBe(0);
  expect(m.overrides).toBe(1);
  expect(m.labels).toBe(1);
});
it('no fake zero recurrence or causal verdict without outcomes', () => {
  const m = measureRule(starterLedger().rules[0], []);
  expect(m.treatment_per_1k).toBeNull();
  expect(m.verdict).toBe('cannot assess');
});
it('counts a completed run once and separates rule revisions', () => {
  const r = starterLedger().rules[0],
    base = {
      timestamp: new Date().toISOString(),
      type: 'outcome',
      rule_id: r.id,
      rule_version: ruleVersion(r),
      cohort: 'treatment',
      session_id: 's',
    };
  const m = measureRule(r, [
    { ...base, id: 'a', failure: true },
    { ...base, id: 'b', failure: false },
    { ...base, id: 'c', rule_version: 'old', session_id: 'other', failure: true },
  ] as any);
  expect(m.treatment_runs).toBe(1);
  expect(m.treatment_per_1k).toBe(0);
});
it('model change proposes shadow, never automatic activation', () => {
  const v = starterLedger();
  v.rules[0].status = 'active';
  v.rules[0].pinned.model = 'old';
  expect(lifecycle(v, [], 'new')).toEqual([
    { id: 'loop-breaker', status: 'shadow', reason: 'Model changed; earn activation again' },
  ]);
});
it('imports prompt candidates silently and pins their source hash', () => {
  const rs = importPrompt(
    'You are helpful.\nWhen a tool fails, read the error.\nNever invent IDs.',
  );
  expect(rs).toHaveLength(2);
  expect(rs.every((r) => r.status === 'shadow' && r.pinned.prompt_hash)).toBe(true);
});
it('pairs OpenAI and Anthropic results without double counting', () => {
  const ts = normalizeExport({
    id: 's',
    messages: [
      {
        role: 'assistant',
        tool_calls: [
          { type: 'function', id: 'c1', function: { name: 'write', arguments: '{"id":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"error":"bad id"}' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'read', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c2', content: '{"success":true}' }],
      },
    ],
  });
  expect(ts[0].tools).toHaveLength(2);
  expect(ts[0].tools.map((t) => t.status)).toEqual(['error', 'success']);
});
it('imports OTel tool spans by trace and filters non-tool spans', () => {
  const ts = normalizeExport({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: 't',
                spanId: 'a',
                name: 'read',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000000000001000',
                attributes: [{ key: 'gen_ai.tool.name', value: { stringValue: 'read' } }],
              },
              { traceId: 't', name: 'llm', attributes: [] },
            ],
          },
        ],
      },
    ],
  });
  expect(ts).toHaveLength(1);
  expect(ts[0].tools[0].tool).toBe('read');
});
it('offline backtest reports matches without claiming measured lift', () => {
  const l = starterLedger();
  const t = {
    id: 't',
    model: 'm',
    timestamp: new Date().toISOString(),
    tools: Array.from({ length: 4 }, () => ({
      tool: 'write',
      args: { id: 'a' },
      status: 'error' as const,
    })),
  };
  const b = backtest(l, [t]);
  expect(b[0].occurrences).toBeGreaterThan(0);
  expect(b[0].verdict).toBe('cannot assess');
  expect(b[0].failures).toBe(1);
});
it('clusters trace failures into shadow proposals with evidence', () => {
  const ps = propose([
    {
      id: 't',
      model: 'm',
      timestamp: new Date().toISOString(),
      tools: [
        { tool: 'write', args: {}, status: 'error', error: 'node 123 failed' },
        { tool: 'write', args: {}, status: 'error', error: 'node 456 failed' },
      ],
    },
  ]);
  expect(ps).toHaveLength(1);
  expect(ps[0].count).toBe(2);
  expect(ps[0].rule.status).toBe('shadow');
});
