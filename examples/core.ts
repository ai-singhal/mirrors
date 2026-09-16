/** Run after building: npx tsx examples/core.ts. No model calls. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runtime, Store, starterLedger, contextSchema, explain } from '../src/index.js';
const store = new Store(mkdtempSync(join(tmpdir(), 'mirrors-example-')));
store.init(starterLedger());
const runtime = new Runtime(store);
const ctx = contextSchema.parse({
  session_id: 'example-run',
  model: 'example-model',
  step: 2,
  capabilities: ['inject'],
  trajectory: [
    { tool: 'write', args: { id: 'a' }, status: 'error' },
    { tool: 'write', args: { id: 'a' }, status: 'error' },
  ],
});
const decision = await runtime.evaluate(ctx);
console.log(explain(decision).join('\n'));
console.log('Shadow leaves the model unchanged:', decision.injection === undefined);
console.log('Example ledger:', store.path);
