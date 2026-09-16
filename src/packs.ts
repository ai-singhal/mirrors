import { ledgerSchema, ruleSchema, type Ledger } from './schema.js';
export function starterLedger(): Ledger {
  return ledgerSchema.parse({
    version: 1,
    name: 'My agent',
    rules: [
      {
        id: 'loop-breaker',
        name: 'Break repeated tool failures',
        description: 'Notice when the same tool and arguments keep failing.',
        condition: {
          type: 'code',
          when: {
            all: [
              { field: 'repeat_count', op: 'gte', value: 2 },
              { field: 'last.status', op: 'eq', value: 'error' },
            ],
          },
        },
        actions: [
          {
            type: 'inject',
            text: 'The same tool call has failed repeatedly. Read the error, check the current target and schema, and change the relevant input before retrying. If the read and write tools disagree, stop retrying and explain the mismatch.',
          },
        ],
        failure: {
          class: 'repeated-tool-error',
          when: {
            all: [
              { field: 'repeat_count', op: 'gte', value: 3 },
              { field: 'last.status', op: 'eq', value: 'error' },
            ],
          },
        },
        priority: 100,
        source: { kind: 'pack', ref: 'loop-breaker@1' },
        expiry: { idle_days: 30, override_limit: 3, min_runs: 30 },
      },
      {
        id: 'fresh-edit-target',
        name: 'Check rejected document targets',
        description: 'Read and write tools may disagree about valid node IDs.',
        condition: {
          type: 'code',
          when: {
            all: [
              { field: 'last.status', op: 'eq', value: 'error' },
              {
                any: [
                  { field: 'last.error', op: 'contains', value: 'node' },
                  { field: 'last.error', op: 'contains', value: 'selector' },
                  { field: 'last.error', op: 'contains', value: 'old_string' },
                ],
              },
            ],
          },
        },
        actions: [
          {
            type: 'inject',
            text: 'The edit target was rejected. Compare the exact ID or selector returned by the read tool with the writer schema. Do not assume another identical read will fix an incompatible ID format.',
          },
        ],
        priority: 80,
        source: { kind: 'pack', ref: 'document-edits@1' },
      },
      {
        id: 'load-before-retry',
        name: 'Load the tool before retrying',
        condition: {
          type: 'code',
          when: { field: 'last.error', op: 'contains', value: 'not loaded' },
        },
        actions: [
          {
            type: 'inject',
            text: 'Load the missing tool and inspect its schema before retrying this call.',
          },
        ],
        priority: 90,
        source: { kind: 'pack', ref: 'tool-readiness@1' },
      },
      {
        id: 'completion-evidence',
        name: 'Check the artifact before declaring completion',
        condition: {
          type: 'code',
          when: {
            all: [
              { field: 'proposed.tool', op: 'eq', value: 'task_complete' },
              { field: 'last.status', op: 'eq', value: 'error' },
            ],
          },
        },
        actions: [
          {
            type: 'block',
            reason:
              'The latest tool operation failed. Verify the requested artifact or clearly report the incomplete result before declaring success.',
          },
        ],
        priority: 100,
        source: { kind: 'pack', ref: 'completion-evidence@1' },
      },
    ],
    budgets: [{ failure_class: 'repeated-tool-error', ceiling_per_1k: 50, min_runs: 30 }],
  });
}
