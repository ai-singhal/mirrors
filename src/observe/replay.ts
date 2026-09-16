import { randomUUID } from 'node:crypto';
import { hash } from '../engine.js';
import { detect } from './signals.js';
import type { ObservationStore } from './database.js';
import type { Run, Message, Call, Signal } from './schema.js';
export type ReplayAnswer = {
  text: string;
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
};
export type ReplayModel = (request: {
  messages: Message[];
  tools: any[];
  model: string;
  signal: AbortSignal;
}) => Promise<ReplayAnswer>;
export async function replayRun(
  run: Run,
  signals: Signal[],
  callModel: ReplayModel,
  options: {
    model: string;
    system?: string;
    tools?: any[];
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) {
  const replayed = structuredClone(run);
  replayed.model = options.model;
  const replacements = new Map<number, Message>();
  let aligned = 0,
    reason: string | undefined;
  let status: 'completed' | 'diverged' | 'unreplayable' | 'error' = 'completed';
  const needsTools = run.steps.some((s) => s.tool_calls.length);
  const tools = options.tools ?? run.tool_definitions;
  if (
    !run.messages.length ||
    run.steps.some((s) => s.message_index === null) ||
    (needsTools && !tools.length)
  )
    return {
      run_id: run.id,
      status: 'unreplayable',
      aligned_steps: 0,
      reason:
        'Missing captured message prefixes or tool schemas; provide recorded schemas explicitly.',
      before: [],
      after: [],
    };
  for (const step of run.steps) {
    if (options.signal?.aborted) {
      status = 'error';
      reason = 'Replay deadline reached';
      break;
    }
    if (step.tool_calls.some((c) => c.result === undefined || c.result_complete === false)) {
      status = 'unreplayable';
      reason = 'A recorded tool result is missing or truncated';
      break;
    }
    let messages = run.messages
      .slice(0, step.message_index!)
      .map((m, i) => replacements.get(i) ?? m);
    if (options.system !== undefined)
      messages = [
        { role: 'system', text: options.system },
        ...messages.filter((m) => m.role !== 'system'),
      ];
    try {
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30000);
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      timeout.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: (() => void) | undefined;
      let answer: ReplayAnswer;
      try {
        answer = await Promise.race([
          callModel({ messages, tools, model: options.model, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            rejectAbort = () => reject(Error('Replay batch deadline reached'));
            controller.signal.addEventListener('abort', rejectAbort, { once: true });
            timer = setTimeout(() => {
              controller.abort();
              reject(Error('Model replay timed out'));
            }, options.timeoutMs ?? 30000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
        options.signal?.removeEventListener('abort', abort);
        timeout.removeEventListener('abort', abort);
      }
      if (
        answer.calls.length !== step.tool_calls.length ||
        answer.calls.some(
          (c, i) =>
            c.name !== step.tool_calls[i].name || hash(c.args) !== step.tool_calls[i].args_hash,
        )
      ) {
        status = 'diverged';
        reason = `Model chose a different tool sequence or arguments at step ${step.idx}; later outcomes are unscored`;
        break;
      }
      const calls: Call[] = answer.calls.map((c, i) => ({
        ...step.tool_calls[i],
        name: c.name,
        args: c.args,
      }));
      replayed.steps[step.idx] = { ...step, tool_calls: calls, final_message: answer.text };
      replacements.set(step.message_index!, { role: 'assistant', text: answer.text, calls });
      aligned++;
    } catch (e) {
      status = 'error';
      reason = String(e);
      break;
    }
  }
  const prefix = (r: Run) => ({
    ...r,
    steps: r.steps.slice(0, aligned),
    completed: status === 'completed' && r.completed,
  });
  const score = (r: Run) => signals.map((s) => ({ signal_id: s.id, ...detect(s, prefix(r)) }));
  return {
    run_id: run.id,
    status,
    aligned_steps: aligned,
    total_steps: run.steps.length,
    reason,
    before: score(run),
    after: score(replayed),
  };
}
export async function replayAffected(
  store: ObservationStore,
  signalId: string,
  callModel: ReplayModel,
  options: {
    model: string;
    system?: string;
    tools?: any[];
    limit?: number;
    concurrency?: number;
    deadlineMs?: number;
    timeoutMs?: number;
  },
) {
  const signal = store.signals().find((s) => s.id === signalId);
  if (!signal) throw Error('Unknown signal');
  const rows = store.db
    .prepare('SELECT DISTINCT run_id FROM signal_hits WHERE signal_id=? LIMIT ?')
    .all(signalId, options.limit ?? 100) as any[];
  const start = Date.now(),
    deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? 600000);
  const reports: any[] = [];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(8, Math.max(1, options.concurrency ?? 4)) }, async () => {
        while (next < rows.length) {
          const row = rows[next++];
          if (deadline.signal.aborted) {
            reports.push({
              run_id: row.run_id,
              status: 'error',
              reason: 'Batch deadline reached before this run',
              aligned_steps: 0,
              before: [],
              after: [],
            });
            continue;
          }
          reports.push(
            await replayRun(store.run(row.run_id), [signal], callModel, {
              ...options,
              signal: deadline.signal,
            }),
          );
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
  const complete = reports.filter((r) => r.status === 'completed');
  const report = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    signal_id: signalId,
    model: options.model,
    elapsed_ms: Date.now() - start,
    runs: reports,
    summary: {
      selected: rows.length,
      completed: complete.length,
      diverged: reports.filter((r) => r.status === 'diverged').length,
      unreplayable: reports.filter((r) => r.status === 'unreplayable').length,
      errors: reports.filter((r) => r.status === 'error').length,
      before_hits: complete.filter((r) => r.before.some((s: any) => s.hits.length)).length,
      after_hits: complete.filter((r) => r.after.some((s: any) => s.hits.length)).length,
    },
    notice:
      'Cached-result LLM replay only. Divergence is not a pass. No tools executed; no live effectiveness claim.',
  };
  store.db
    .prepare('INSERT INTO replay_reports VALUES(?,?,?)')
    .run(report.id, report.created_at, JSON.stringify(report));
  return report;
}
