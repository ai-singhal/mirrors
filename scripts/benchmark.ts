import { performance } from 'node:perf_hooks';
import { Engine } from '../src/engine';
import { ruleSchema, contextSchema } from '../src/schema';
const rules = Array.from({ length: 500 }, (_, i) =>
  ruleSchema.parse({
    id: `rule-${i}`,
    name: `Rule ${i}`,
    condition: {
      type: 'code',
      when: {
        all: [
          { field: 'last.status', op: 'eq', value: 'error' },
          { field: 'repeat_count', op: 'gte', value: 2 },
        ],
      },
    },
    actions: [{ type: 'inject', text: 'Check the result before retrying.' }],
    status: 'active',
    rollout: 50,
  }),
);
const e = new Engine({ version: 1, rules }),
  ctx = contextSchema.parse({
    session_id: 'benchmark',
    step: 2,
    model: 'benchmark',
    trajectory: [
      { tool: 'write', args: { id: 'a' }, status: 'error' },
      { tool: 'write', args: { id: 'a' }, status: 'error' },
    ],
  });
for (let i = 0; i < 300; i++) e.evaluate(ctx);
const samples = [];
for (let i = 0; i < 1000; i++) {
  const start = performance.now();
  e.evaluate({ ...ctx, session_id: 'run-' + i });
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const report = {
  rules: 500,
  iterations: 1000,
  p50_ms: samples[500],
  p95_ms: samples[950],
  p99_ms: samples[990],
  target_p95_ms: 5,
  scope:
    'In-process code evaluation; excludes schema compilation, disk telemetry, HTTP, and judgment models.',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
};
console.log(JSON.stringify(report, null, 2));
if (report.p95_ms > 5) process.exitCode = 1;
