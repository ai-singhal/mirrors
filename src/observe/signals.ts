import type { Run, Signal, SignalResult, Hit } from './schema.js';
const definitions: [string, string, string][] = [
  [
    'invalid-target-error',
    'Invalid edit target',
    'An explicit tool error mentions node, selector, old_string, target.id, target ID, or an invalid/not-found target. This flags the observed contract failure, not its cause.',
  ],
  [
    'repeated-identical-error',
    'Repeated identical failed call',
    'Two consecutive tool calls have the same name and canonical arguments and both explicitly fail.',
  ],
  [
    'unresolved-tool-error',
    'Unresolved final tool error',
    'The last observed tool call of a completed run explicitly failed. Recovery outside recorded tool calls is not inferred.',
  ],
  [
    'success-claim-after-error',
    'Success language after an error',
    'A final assistant message contains done, completed, successfully, or ready to download after an unresolved explicit tool error. This is a lexical candidate, not a truth judgment.',
  ],
  [
    'open-without-read',
    'Opened without a read',
    'A tool whose name starts with open_ or ends in _open succeeds, and no later tool name contains read, extract, or parse. This is a naming-convention check.',
  ],
  [
    'step-budget-exceeded',
    'Tool step budget exceeded',
    'A run contains more than 25 recorded tool calls. This threshold measures excess against a configured budget, not task failure by itself.',
  ],
  [
    'error-ignored',
    'Error followed by unrelated call',
    'An explicit tool error is immediately followed by a different tool that is not named read, inspect, load, search, get, or validate. Review whether the transition is a legitimate recovery.',
  ],
  [
    'empty-result-retry',
    'Repeated empty search',
    'A successful search or query returns an empty array, results array, or items array and the next call repeats the same tool and arguments.',
  ],
  [
    'invalid-target-retry',
    'Rejected target repeated',
    'An invalid-target error is followed immediately by the same tool and argument hash.',
  ],
  [
    'tool-not-loaded',
    'Tool unavailable',
    'A recorded tool error explicitly matches not loaded, load tool, or unknown tool.',
  ],
  [
    'write-before-read',
    'Write before any read',
    'A tool name containing write, edit, patch, or replace occurs before any tool name containing read, inspect, get, or fetch. This is a sequence convention, not proof of an incorrect write.',
  ],
];
export const builtInSignals = (): Signal[] =>
  definitions.map(([id, name, definition_text]) => ({
    id,
    name,
    definition_text,
    kind: 'code',
    threshold: 1,
    detector: id,
    config: id === 'step-budget-exceeded' ? { max_calls: 25 } : {},
    labeled_sample_path: null,
  }));
export function detect(signal: Signal, run: Run): SignalResult {
  if (signal.kind === 'judgment')
    return { assessable: false, hits: [], reason: 'Judgment not requested' };
  const calls = run.steps.flatMap((s) => s.tool_calls.map((c) => ({ ...c, idx: s.idx })));
  const hits: Hit[] = [];
  const hit = (idx: number, reason: string) => hits.push({ step_idx: idx, confidence: 1, reason });
  const last = calls.at(-1);
  const known = calls.some((c) => c.status !== 'unknown');
  const equal = (a: (typeof calls)[number], b: (typeof calls)[number]) =>
    a.name === b.name && a.args_hash === b.args_hash;
  switch (signal.detector) {
    case 'invalid-target-error':
      for (const c of calls)
        if (c.status === 'error' && c.error_class === 'invalid-target')
          hit(c.idx, 'Tool rejected its target or selector');
      break;
    case 'repeated-identical-error':
      for (let i = 1; i < calls.length; i++)
        if (
          calls[i].status === 'error' &&
          calls[i - 1].status === 'error' &&
          equal(calls[i], calls[i - 1])
        )
          hit(calls[i].idx, 'Same tool and arguments explicitly failed twice');
      break;
    case 'unresolved-tool-error':
      if (!run.completed) return { assessable: false, hits: [], reason: 'Run incomplete' };
      if (last?.status === 'error') hit(last.idx, 'Final tool result is an error');
      break;
    case 'success-claim-after-error': {
      const final = run.steps.at(-1);
      if (!run.completed || !final?.final_message)
        return { assessable: false, hits: [], reason: 'No completed final message' };
      if (
        last?.status === 'error' &&
        final.idx >= last.idx &&
        /\b(done|completed|successfully|ready to download)\b/i.test(final.final_message)
      )
        hit(final.idx, 'Completion vocabulary appears after an unresolved tool error');
      break;
    }
    case 'open-without-read':
      for (let i = 0; i < calls.length; i++)
        if (
          /(^open_|_open$)/i.test(calls[i].name) &&
          calls[i].status === 'success' &&
          !calls.slice(i + 1).some((c) => /read|extract|parse/i.test(c.name))
        )
          hit(calls[i].idx, 'Open succeeded without a later read/extract/parse call');
      break;
    case 'step-budget-exceeded': {
      const max = Number(signal.config.max_calls ?? 25);
      if (calls.length > max)
        hit(calls[max].idx, `${calls.length} tool calls exceed the ${max}-call budget`);
      break;
    }
    case 'error-ignored':
      for (let i = 1; i < calls.length; i++)
        if (
          calls[i - 1].status === 'error' &&
          calls[i].name !== calls[i - 1].name &&
          !/read|inspect|load|search|get|validate/i.test(calls[i].name)
        )
          hit(calls[i].idx, 'Error followed by a different non-recovery-named tool');
      break;
    case 'empty-result-retry': {
      if (!calls.some((c) => 'result' in c))
        return { assessable: false, hits: [], reason: 'Tool results missing' };
      for (let i = 1; i < calls.length; i++) {
        const p = calls[i - 1],
          r = p.result as any;
        const empty = Array.isArray(r)
          ? !r.length
          : Array.isArray(r?.results)
            ? !r.results.length
            : Array.isArray(r?.items)
              ? !r.items.length
              : false;
        if (p.status === 'success' && /search|query/i.test(p.name) && empty && equal(p, calls[i]))
          hit(calls[i].idx, 'Same query repeated after an explicitly empty result');
      }
      break;
    }
    case 'invalid-target-retry':
      for (let i = 1; i < calls.length; i++)
        if (calls[i - 1].error_class === 'invalid-target' && equal(calls[i], calls[i - 1]))
          hit(calls[i].idx, 'Rejected target retried with identical arguments');
      break;
    case 'tool-not-loaded':
      for (const c of calls)
        if (c.status === 'error' && c.error_class === 'tool-unavailable')
          hit(c.idx, 'Explicit tool-unavailable error');
      break;
    case 'write-before-read': {
      let read = false;
      for (const c of calls) {
        if (/read|inspect|get|fetch/i.test(c.name)) read = true;
        if (!read && /write|edit|patch|replace/i.test(c.name))
          hit(c.idx, 'Write/edit before any observed read/get/inspect/fetch');
      }
      break;
    }
    default:
      return { assessable: false, hits: [], reason: 'Unknown detector' };
  }
  const statusRequired = ![
    'step-budget-exceeded',
    'write-before-read',
    'empty-result-retry',
  ].includes(signal.detector);
  return { assessable: statusRequired ? known : true, hits };
}
