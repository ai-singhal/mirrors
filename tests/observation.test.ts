import { it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservationStore } from '../src/observe/database';
import { normalizeRuns } from '../src/observe/normalize';
import { builtInSignals, detect } from '../src/observe/signals';
import { releaseHealth, signalSummary, fixResults, verifyFix } from '../src/observe/health';
import { clusterIntents, nameIntent } from '../src/observe/intents';
import { replayRun, replayAffected } from '../src/observe/replay';
import { judgeSignals } from '../src/observe/model';
const stores: ObservationStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
const db = () => {
  const d = new ObservationStore(mkdtempSync(join(tmpdir(), 'mirrors-observe-')));
  stores.push(d);
  return d;
};
function run(calls: { name: string; args?: any; error?: string; result?: any }[], patch: any = {}) {
  const messages: any[] = [
    { role: 'system', content: 'System' },
    { role: 'user', content: 'Edit the document' },
  ];
  for (const [i, c] of calls.entries()) {
    messages.push(
      {
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            id: 'c' + i,
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c' + i,
        content: JSON.stringify(c.error ? { error: c.error } : (c.result ?? { ok: true })),
      },
    );
  }
  messages.push({ role: 'assistant', content: patch.final ?? 'Stopped' });
  return normalizeRuns(
    {
      id: patch.id ?? 'r',
      version: patch.version ?? 'v1',
      model: 'test',
      intent: patch.intent ?? 'editing',
      segment: patch.segment ?? 'all',
      timestamp: new Date(Date.now() - (patch.version === 'v2' ? 1 : 2) * 86400000).toISOString(),
      tools: calls.map((c) => ({
        type: 'function',
        function: { name: c.name, parameters: { type: 'object', properties: {} } },
      })),
      messages,
      ...patch,
    },
    'fixture',
  )[0];
}
const hit = (id: string, r: ReturnType<typeof run>) =>
  detect(
    builtInSignals().find((s) => s.id === id)!,
    r,
  );
const good = () => run([{ name: 'read_document' }, { name: 'edit_document' }]);
const bad = () =>
  run([
    { name: 'edit_document', error: 'Invalid node selector' },
    { name: 'edit_document', error: 'Invalid node selector' },
  ]);
it('retains prefix hashes, cached outputs, errors, model and segment metadata', () => {
  const r = run([{ name: 'edit_document', args: { b: 2, a: 1 }, error: 'Invalid node selector' }], {
    segment: 'law',
  });
  expect(r.steps[0].tool_calls[0]).toMatchObject({
    status: 'error',
    error_class: 'invalid-target',
    result: { error: 'Invalid node selector' },
  });
  expect(r.steps[0].sys_hash).toHaveLength(64);
  expect(r.steps[0].messages_hash).toHaveLength(64);
  expect(r.segment).toBe('law');
  expect(r.version_known).toBe(true);
});
it('does not fabricate version tags or timestamps', () => {
  const r = normalizeRuns({ id: 'r', messages: [{ role: 'assistant', content: 'Hello' }] }, 'x')[0];
  expect(r.version_known).toBe(false);
  expect(r.started_at).toMatch(/^1970/);
});
it('ingestion is idempotent and keeps raw content outside the SQL run index', () => {
  const s = db(),
    r = bad();
  s.ingest(r);
  s.ingest(r);
  expect(s.runs()).toHaveLength(1);
  expect((s.db.prepare('SELECT COUNT(*) n FROM steps').get() as any).n).toBe(2);
  expect(s.run(r.id).steps[0].tool_calls[0].error).toContain('selector');
  expect(s.db.prepare('SELECT * FROM runs').get()).not.toHaveProperty('messages');
});
const positiveCases: [string, () => ReturnType<typeof run>][] = [
  ['invalid-target-error', bad],
  ['repeated-identical-error', bad],
  ['unresolved-tool-error', bad],
  [
    'success-claim-after-error',
    () => run([{ name: 'write', error: 'Rejected' }], { final: 'Done successfully' }),
  ],
  ['open-without-read', () => run([{ name: 'open_document' }])],
  [
    'step-budget-exceeded',
    () => run(Array.from({ length: 26 }, () => ({ name: 'read_document' }))),
  ],
  [
    'error-ignored',
    () => run([{ name: 'read_document', error: 'Unavailable' }, { name: 'publish' }]),
  ],
  [
    'empty-result-retry',
    () =>
      run([
        { name: 'search', result: [] },
        { name: 'search', result: [] },
      ]),
  ],
  ['invalid-target-retry', bad],
  ['tool-not-loaded', () => run([{ name: 'lookup', error: 'Tool not loaded' }])],
  ['write-before-read', () => run([{ name: 'edit_document' }])],
];
for (const [id, make] of positiveCases)
  it(`definition fixture: ${id} has a positive and negative case`, () => {
    expect(hit(id, make()).hits.length).toBeGreaterThan(0);
    expect(hit(id, good()).hits).toHaveLength(0);
  });
it('distinguishes a changed argument from an unchanged retry', () => {
  const r = run([
    { name: 'edit', args: { id: 'a' }, error: 'Invalid node' },
    { name: 'edit', args: { id: 'b' }, error: 'Invalid node' },
  ]);
  expect(hit('repeated-identical-error', r).hits).toEqual([]);
  expect(hit('invalid-target-retry', r).hits).toEqual([]);
});
it('signal definitions cannot silently invalidate existing human samples', () => {
  const s = db();
  expect(() =>
    s.saveSignal({ ...s.signals()[0], definition_text: 'Different definition' }),
  ).toThrow('immutable');
});
it('labels preserve the human reviewer and distinguish positive/negative samples', () => {
  const s = db();
  s.ingest(bad());
  s.ingest(run([{ name: 'read' }], { id: 'negative' }));
  s.label('repeated-identical-error', 'r', 1, true, 'human-reviewer');
  s.label('repeated-identical-error', 'negative', -1, true, 'human-reviewer');
  const m = signalSummary(s).find((s) => s.id === 'repeated-identical-error')!;
  expect(m.labels).toMatchObject({ samples: 2, reviewed: true, precision: 1 });
  expect(
    s.signals().find((s) => s.id === 'repeated-identical-error')?.labeled_sample_path,
  ).toBeTruthy();
});
it('within-intent comparison avoids a traffic-mix false improvement', () => {
  const s = db();
  for (const version of ['v1', 'v2'])
    for (let i = 0; i < 20; i++) {
      const intent = i < (version === 'v1' ? 2 : 18) ? 'easy' : 'hard';
      s.ingest(
        run([{ name: 'lookup', ...(intent === 'hard' ? { error: 'Failed' } : {}) }], {
          id: version + i,
          version,
          intent,
        }),
      );
    }
  const h = releaseHealth(s, { version: 'v2', baseline: 'v1', minRuns: 2 });
  const rows = h.rows.filter((r) => r.signal_id === 'unresolved-tool-error');
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.verdict === 'stable')).toBe(true);
});
it('requires baseline samples and attaches affected runs to regressions', () => {
  const s = db();
  for (const version of ['v1', 'v2'])
    for (let i = 0; i < 3; i++)
      s.ingest(
        run([{ name: 'lookup', ...(version === 'v2' ? { error: 'Failed' } : {}) }], {
          id: version + i,
          version,
        }),
      );
  const h = releaseHealth(s, { minRuns: 2 });
  const r = h.rows.find((r) => r.signal_id === 'unresolved-tool-error')!;
  expect(r.verdict).toBe('regression');
  expect(r.worst).toHaveLength(3);
  expect(releaseHealth(s, { minRuns: 30 }).rows.every((r) => r.verdict === 'insufficient')).toBe(
    true,
  );
});
it('does not compare untagged model identities as if they were deployments', () => {
  const s = db();
  s.ingest({ ...good(), version: 'unversioned:model-a', version_known: false });
  s.ingest({ ...good(), id: 'b', version: 'unversioned:model-b', version_known: false });
  expect(releaseHealth(s).rows).toEqual([]);
});
it('tracks prompt/code fixes across a shared deploy without isolated attribution', () => {
  const s = db();
  for (const version of ['v1', 'v2'])
    for (let i = 0; i < 4; i++)
      s.ingest(
        run([{ name: 'lookup', ...(version === 'v1' ? { error: 'Failed' } : {}) }], {
          id: version + i,
          version,
        }),
      );
  for (const id of ['fix-a', 'fix-b'])
    s.addFix({
      id,
      name: id,
      target_signal_id: 'unresolved-tool-error',
      type: 'code',
      version_id: 'v2',
      baseline_version: 'v1',
      status: 'shipped',
    });
  expect(fixResults(s, 'fix-a', { minRuns: 2 }).shared_deploy).toBe(true);
  expect(() => verifyFix(s, 'fix-a', { minRuns: 2 })).toThrow('Label');
  s.label('unresolved-tool-error', 'v10', 0, true);
  s.label('unresolved-tool-error', 'v20', -1, true);
  expect(verifyFix(s, 'fix-a', { minRuns: 2 }).verified).toBe(true);
});
it('uses intent grouping only as metadata; names persist across inspection', () => {
  const s = db();
  s.ingest({ ...good(), intent: 'unclassified' });
  const groups = clusterIntents(s);
  expect(groups.assigned).toBe(1);
  nameIntent(s, groups.clusters[0].id, 'Document edits');
  expect(s.run('r').intent).toBe('Document edits');
  expect(clusterIntents(s).assigned).toBe(0);
});
it('replay substitutes cached results and preserves generated earlier messages', async () => {
  const r = run([{ name: 'read', result: { answer: 42 } }]);
  let calls = 0;
  const result = await replayRun(
    r,
    builtInSignals(),
    async (req) => {
      calls++;
      if (calls === 1)
        return { text: 'Changed assistant text', calls: [{ name: 'read', args: {} }] };
      expect(req.messages.some((m) => m.text === 'Changed assistant text')).toBe(true);
      expect(req.messages.find((m) => m.role === 'tool')?.result).toEqual({ answer: 42 });
      return { text: 'Finished', calls: [] };
    },
    { model: 'candidate' },
  );
  expect(result.status).toBe('completed');
  expect(calls).toBe(2);
});
it('stops at divergence and never reports it as a fixed failure', async () => {
  const r = bad();
  let calls = 0;
  const result = await replayRun(
    r,
    builtInSignals(),
    async () => {
      calls++;
      return {
        text: 'Try another target',
        calls: [{ name: 'edit_document', args: { id: 'different' } }],
      };
    },
    { model: 'candidate' },
  );
  expect(result.status).toBe('diverged');
  expect(result.aligned_steps).toBe(0);
  expect(calls).toBe(1);
});
it('missing tool schemas skip replay without sending any content', async () => {
  const r = { ...bad(), tool_definitions: [] };
  let called = false;
  const result = await replayRun(
    r,
    builtInSignals(),
    async () => {
      called = true;
      throw Error();
    },
    { model: 'candidate' },
  );
  expect(result.status).toBe('unreplayable');
  expect(called).toBe(false);
});
it('times out replay providers that ignore abort without executing tools', async () => {
  const result = await replayRun(good(), builtInSignals(), () => new Promise(() => {}), {
    model: 'candidate',
    timeoutMs: 10,
  });
  expect(result.status).toBe('error');
});
it('judgment timeout yields no answer rather than a signal hit', async () => {
  const signal = { ...builtInSignals()[0], kind: 'judgment' as const, threshold: 0.9 };
  const result = await judgeSignals(bad(), [signal], () => new Promise(() => {}), 10);
  expect(result[0].result.assessable).toBe(false);
  expect(result[0].result.hits).toEqual([]);
});
it('low confidence and malformed judgment probabilities do not score', async () => {
  const signal = { ...builtInSignals()[0], kind: 'judgment' as const, threshold: 0.9 };
  for (const answer of [
    { p: 1, confidence: 0.1 },
    { p: NaN, confidence: 1 },
  ]) {
    const r = await judgeSignals(bad(), [signal], async () => [{ id: signal.id, ...answer }]);
    expect(r[0].result.assessable).toBe(false);
  }
});
it('reports divergence separately in a bounded affected-run batch', async () => {
  const s = db();
  s.ingest(bad());
  const report = await replayAffected(
    s,
    'repeated-identical-error',
    async () => ({ text: 'Done', calls: [] }),
    { model: 'candidate' },
  );
  expect(report.summary).toMatchObject({
    selected: 1,
    completed: 0,
    diverged: 1,
    before_hits: 0,
    after_hits: 0,
  });
});

it('preserves named intents when a watched export is ingested again', () => {
  const s = db(),
    r = { ...good(), intent: 'unclassified' };
  s.ingest(r);
  const group = clusterIntents(s).clusters[0];
  nameIntent(s, group.id, 'Human name');
  s.ingest(r);
  expect(s.run(r.id).intent).toBe('Human name');
  expect(clusterIntents(s).assigned).toBe(0);
});
it('invalidates labels when the underlying run content changes', () => {
  const s = db();
  s.ingest(bad());
  s.label('repeated-identical-error', 'r', 1, true);
  s.ingest(good());
  expect((s.db.prepare('SELECT COUNT(*) n FROM labels').get() as any).n).toBe(0);
});
it('refuses to replay explicitly truncated cached outputs', async () => {
  const r = good();
  r.steps[0].tool_calls[0].result_complete = false;
  let called = false;
  const result = await replayRun(
    r,
    builtInSignals(),
    async () => {
      called = true;
      throw Error();
    },
    { model: 'candidate' },
  );
  expect(result.status).toBe('unreplayable');
  expect(called).toBe(false);
});
it('the batch deadline interrupts a provider that ignores cancellation', async () => {
  const s = db();
  s.ingest(bad());
  const start = Date.now();
  const report = await replayAffected(s, 'repeated-identical-error', () => new Promise(() => {}), {
    model: 'candidate',
    deadlineMs: 10,
    timeoutMs: 1000,
  });
  expect(Date.now() - start).toBeLessThan(300);
  expect(report.summary.errors).toBe(1);
});
it('registers an optional runtime fix and a linked shadow rule', async () => {
  const { registerFix } = await import('../src/observe/service');
  const s = db();
  const fix = registerFix(s, {
    id: 'runtime-fix',
    name: 'When the same tool call fails twice, inspect its error',
    target_signal_id: 'repeated-identical-error',
    type: 'rule',
  });
  expect(fix.rule_id).toBeTruthy();
  const rule = s.db.prepare('SELECT * FROM rules WHERE fix_id=?').get(fix.id) as any;
  expect(rule.status).toBe('shadow');
});
it('recognizes native River alternate user text and truncation metadata', () => {
  const r = normalizeRuns(
    {
      id: 'native',
      messages: [
        { role: 'user', content: [{ type: 'user_message', userText: 'Find the document' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', id: 'a', name: 'read', input: {}, resolved_outcome: 'success' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: '{"partial":true}', truncated: true },
          ],
        },
      ],
    },
    'fixture',
  )[0];
  expect(r.first_user_message).toBe('Find the document');
  expect(r.steps[0].tool_calls[0].result_complete).toBe(false);
  expect(r.raw).toBeDefined();
});

it('imports OTel model, version, tool results and duration without customer code', () => {
  const [r] = normalizeRuns(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't',
                  spanId: 's',
                  name: 'lookup',
                  startTimeUnixNano: '1789516800000000000',
                  endTimeUnixNano: '1789516800005000000',
                  attributes: [
                    { key: 'gen_ai.tool.name', value: { stringValue: 'lookup' } },
                    { key: 'gen_ai.request.model', value: { stringValue: 'actual-model' } },
                    { key: 'service.version', value: { stringValue: 'deployed-v1' } },
                    { key: 'output.value', value: { stringValue: '{"items":[]}' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    'otel',
  );
  expect(r.model).toBe('actual-model');
  expect(r.version).toBe('deployed-v1');
  expect(r.version_known).toBe(true);
  expect(r.steps[0].tool_calls[0]).toMatchObject({ result: { items: [] }, duration_ms: 5 });
});
it('interprets timezone-free River timestamps as UTC', () => {
  const [r] = normalizeRuns(
    {
      id: 'utc',
      timestamp: '2026-09-16 12:00:00.000000',
      messages: [{ role: 'assistant', content: 'Hello' }],
    },
    'fixture',
  );
  expect(r.started_at).toBe('2026-09-16T12:00:00.000Z');
});
it('unknown explicit versions cannot silently select a different release', () => {
  const s = db();
  s.ingest(good());
  expect(() => releaseHealth(s, { version: 'typo' })).toThrow('Unknown version');
});

it('preserves structured tool errors instead of reducing them to object Object', () => {
  const [r] = normalizeRuns(
    {
      id: 'structured-error',
      tools: [
        {
          tool: 'doc_write',
          args: {},
          status: 'error',
          error: { code: 'TARGET_INVALID', message: 'Unknown node ID' },
        },
      ],
    },
    'fixture',
  );
  expect(r.steps[0].tool_calls[0].error_class).toBe('invalid-target');
  expect(r.steps[0].tool_calls[0].error).toContain('Unknown node ID');
});
