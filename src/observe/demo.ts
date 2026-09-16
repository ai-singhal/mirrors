import type { ObservationStore } from './database.js';
import { normalizeRuns } from './normalize.js';
import { ingestRuns } from './service.js';
export function createObservationDemo(db: ObservationStore) {
  const runs = [];
  for (const [v, day] of [
    ['release-1', 4],
    ['release-2', 1],
  ] as const) {
    for (let i = 0; i < 180; i++) {
      const intent = i % 2 ? 'Research documents' : 'Edit documents';
      const segment = i % 3 ? 'Professional' : 'Student';
      const failure =
        intent === 'Edit documents'
          ? v === 'release-1'
            ? i % 4 === 0
            : i % 12 === 0
          : v === 'release-1'
            ? i % 15 === 0
            : i % 5 === 0;
      const tool = intent === 'Edit documents' ? 'edit_document' : 'search';
      const messages: any[] = [
        { role: 'system', content: 'Synthetic demo agent' },
        { role: 'user', content: intent },
        {
          role: 'assistant',
          tool_calls: [
            { type: 'function', id: 'read', function: { name: 'read_document', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'read', content: '{"ok":true}' },
      ];
      for (let j = 0; j < (failure ? 3 : 1); j++) {
        messages.push(
          {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                id: 'call-' + j,
                function: { name: tool, arguments: '{"id":"demo"}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call-' + j,
            content: failure ? ' {"error":"Invalid node target"}' : '{"ok":true}',
          },
        );
      }
      messages.push({
        role: 'assistant',
        content: failure ? 'I could not complete the task.' : 'Completed successfully.',
      });
      runs.push(
        ...normalizeRuns(
          {
            id: `synthetic-${v}-${i}`,
            version: v,
            model: 'demo-model',
            intent,
            segment,
            timestamp: new Date(Date.now() - day * 86400000 + i * 1000).toISOString(),
            messages,
            tools: [
              {
                type: 'function',
                function: { name: 'read_document', parameters: { type: 'object', properties: {} } },
              },
              {
                type: 'function',
                function: {
                  name: tool,
                  parameters: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            ],
          },
          'synthetic-demo',
        ),
      );
    }
  }
  ingestRuns(db, runs);
  for (const [i, signal] of [
    'invalid-target-retry',
    'repeated-identical-error',
    'write-before-read',
  ].entries())
    db.addFix({
      id: 'demo-fix-' + i,
      name: [
        'Refresh rejected document targets',
        'Stop unchanged retries',
        'Read before document edits',
      ][i],
      target_signal_id: signal,
      type: i === 0 ? 'code' : i === 1 ? 'prompt' : 'rule',
      version_id: 'release-2',
      baseline_version: 'release-1',
      model: 'demo-model',
      status: 'shipped',
      source: 'synthetic-demo',
      notes: 'Synthetic demonstration; not production evidence.',
    });
  // Sample outcomes remain unlabelled: human reviews are never fabricated.
}
