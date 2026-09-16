import { describe, it, expect } from 'vitest';
import { Engine, appendTail, cohort, hash, features, compilePredicate } from '../src/engine';
import { ruleSchema, contextSchema } from '../src/schema';
const ctx = () =>
  contextSchema.parse({
    session_id: 'run-1',
    step: 2,
    model: 'model-a',
    tools: ['read', 'write'],
    trajectory: [
      { tool: 'write', args: { b: 2, a: 1 }, status: 'error' },
      { tool: 'write', args: { a: 1, b: 2 }, status: 'error' },
    ],
  });
const rule = (patch: any = {}) =>
  ruleSchema.parse({
    id: 'repeat',
    name: 'Stop loops',
    condition: { type: 'code', when: { field: 'repeat_count', op: 'gte', value: 2 } },
    actions: [{ type: 'inject', text: 'Inspect state.' }],
    status: 'active',
    rollout: 100,
    ...patch,
  });
const engine = (...rules: any[]) => new Engine({ version: 1, rules });
describe('runtime invariants', () => {
  it('canonicalizes argument order and detects consecutive repeats', () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(features(ctx()).repeat_count).toBe(2);
  });
  it('keeps a shadow rule completely passive', () => {
    const d = engine(rule({ status: 'shadow' })).evaluate(ctx());
    expect(d.injection).toBeUndefined();
    expect(d.evaluations[0].outcome).toBe('shadow');
  });
  it('only adds a tail message, preserving original references and bytes', () => {
    const messages = [
      { role: 'system', content: 'original' },
      { role: 'user', content: 'task' },
    ];
    const before = JSON.stringify(messages);
    const d = engine(rule()).evaluate(ctx());
    const next = appendTail(messages, d);
    expect(next.slice(0, 2)).toEqual(messages);
    expect(next[0]).toBe(messages[0]);
    expect(JSON.stringify(messages)).toBe(before);
    expect(next.at(-1)?.role).toBe('user');
  });
  it('does not modify control sessions', () => {
    const r = rule({ rollout: 0 });
    expect(cohort(r, 'x')).toBe('control');
    expect(engine(r).evaluate(ctx()).injection).toBeUndefined();
  });
  it('assigns stable sessions independently of step', () => {
    const r = rule({ rollout: 50 });
    expect(cohort(r, 'a')).toBe(cohort(r, 'a'));
    const cohorts = Array.from({ length: 1000 }, (_, i) => cohort(r, '' + i));
    expect(cohorts.filter((c) => c === 'treatment').length).toBeGreaterThan(400);
    expect(cohorts.filter((c) => c === 'treatment').length).toBeLessThan(600);
  });
  it('allows only the highest-priority injection', () => {
    const d = engine(
      rule({ id: 'low', priority: 0 }),
      rule({ id: 'high', priority: 10, actions: [{ type: 'inject', text: 'Winner' }] }),
    ).evaluate(ctx());
    expect(d.injection).toBe('Winner');
    expect(d.evaluations.find((e) => e.rule_id === 'low')?.outcome).toBe('suppressed');
  });
  it('composes masking and model routing', () => {
    const d = engine(
      rule({
        actions: [
          { type: 'inject', text: 'Wait' },
          { type: 'mask_tools', tools: ['write'] },
          { type: 'swap_model', model: 'model-b' },
        ],
      }),
    ).evaluate(ctx());
    expect(d.masked_tools).toEqual(['write']);
    expect(d.model).toBe('model-b');
  });
  it('masking wins over a conflicting forced tool', () => {
    const d = engine(
      rule({
        actions: [
          { type: 'force_tool', tool: 'write' },
          { type: 'mask_tools', tools: ['write'] },
        ],
      }),
    ).evaluate(ctx());
    expect(d.forced_tool).toBeUndefined();
    expect(d.evaluations[0].actions.some((a) => a.type === 'force_tool')).toBe(false);
  });
  it('does not force unavailable tools', () =>
    expect(
      engine(rule({ actions: [{ type: 'force_tool', tool: 'missing' }] })).evaluate(ctx())
        .forced_tool,
    ).toBeUndefined());
  it('blocks only in the tool phase', () => {
    const e = engine(rule({ actions: [{ type: 'block', reason: 'Repeated failure' }] }));
    expect(e.evaluate(ctx()).blocked).toBe(false);
    expect(e.evaluate({ ...ctx(), phase: 'tool' }).blocked).toBe(true);
  });
  it('queues human review and blocks execution', () => {
    const d = engine(rule({ actions: [{ type: 'human', reason: 'Need a decision' }] })).evaluate({
      ...ctx(),
      phase: 'tool',
    });
    expect(d.blocked).toBe(true);
    expect(d.human).toBe('Need a decision');
  });
  it('auto-shadows model and missing prompt-pin mismatches', () => {
    for (const pinned of [{ model: 'new-model' }, { prompt_hash: 'missing' }]) {
      const d = engine(rule({ pinned })).evaluate(ctx());
      expect(d.injection).toBeUndefined();
      expect(d.evaluations[0].cohort).toBe('shadow');
    }
  });
  it('does not fire expired rules', () =>
    expect(
      engine(rule({ expiry: { expires_at: '2000-01-01T00:00:00.000Z' } })).evaluate(ctx())
        .injection,
    ).toBeUndefined());
  it('does not fire unsupported adapter actions', () => {
    const d = engine(rule()).evaluate({ ...ctx(), capabilities: ['block'] });
    expect(d.injection).toBeUndefined();
    expect(d.evaluations[0].outcome).toBe('skipped');
  });
  it('does not invoke off or retired rules', () => {
    expect(
      engine(rule({ status: 'off' }), rule({ id: 'retired', status: 'retired' })).evaluate(ctx())
        .evaluations,
    ).toEqual([]);
  });
  it('rejects duplicate IDs and deep conditions', () => {
    expect(() => engine(rule(), rule())).toThrow('Duplicate');
    let p: any = { field: 'step', op: 'eq', value: 2 };
    for (let i = 0; i < 18; i++) p = { not: p };
    expect(() => engine(rule({ condition: { type: 'code', when: p } }))).toThrow('nesting');
  });
  it('never resolves prototype fields', () =>
    expect(compilePredicate({ field: '__proto__.x', op: 'exists' })({})).toBe(false));
  it('counts proposed repetition against history without adding an unexecuted call', () =>
    expect(
      features({ ...ctx(), proposed: { tool: 'read', args: {}, status: 'unknown' } }).repeat_count,
    ).toBe(0));
  it('times out a judge that ignores cancellation without intervening', async () => {
    const e = engine(rule({ condition: { type: 'judgment', question: 'Loop?', timeout_ms: 10 } }));
    const start = Date.now();
    const d = await e.evaluateAsync(ctx(), () => new Promise(() => {}));
    expect(Date.now() - start).toBeLessThan(200);
    expect(d.injection).toBeUndefined();
    expect(d.evaluations[0].matched).toBeNull();
  });
  it('requires both a positive judgment and sufficient confidence', async () => {
    const e = engine(rule({ condition: { type: 'judgment', question: 'Loop?', confidence: 0.9 } }));
    expect(
      (await e.evaluateAsync(ctx(), async () => ({ answer: true, confidence: 0.5 }))).injection,
    ).toBeUndefined();
    expect(
      (await e.evaluateAsync(ctx(), async () => ({ answer: true, confidence: 0.95 }))).injection,
    ).toBe('Inspect state.');
  });
  it('fails open when a judge throws', async () =>
    expect(
      (
        await engine(rule({ condition: { type: 'judgment', question: 'Loop?' } })).evaluateAsync(
          ctx(),
          async () => {
            throw Error('offline');
          },
        )
      ).injection,
    ).toBeUndefined());
});
