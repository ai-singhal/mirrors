import type { PrepareStepFunction, ToolSet } from 'ai';
import type { Runtime } from '../runtime.js';
import { appendTail } from '../engine.js';
import type { Context, ToolEvent } from '../schema.js';
export class MirrorsBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorsBlockedError';
  }
}
function trajectory(steps: any[]): ToolEvent[] {
  return steps.flatMap((s) =>
    (s.toolCalls ?? []).map((c: any) => {
      const result = (s.toolResults ?? []).find((r: any) => r.toolCallId === c.toolCallId);
      const error = (s.content ?? []).find(
        (r: any) => r.type === 'tool-error' && r.toolCallId === c.toolCallId,
      );
      const bad = error || result?.output?.error || result?.output?.success === false;
      return {
        id: c.toolCallId,
        tool: c.toolName,
        args: c.input ?? {},
        status: bad ? 'error' : result ? 'success' : 'unknown',
        error: bad ? String(error?.error ?? result?.output?.error ?? 'Tool failed') : undefined,
      };
    }),
  );
}
/** Create one adapter per run. Call finish with the SDK's complete steps to record outcomes. */
export function createAIAdapter(
  runtime: Runtime,
  options: {
    sessionId: string;
    modelId: string;
    promptHash?: string;
    intent?: string;
    tools: string[];
    resolveModel?: (id: string) => any;
  },
) {
  let ctx: Context = {
    session_id: options.sessionId,
    model: options.modelId,
    prompt_hash: options.promptHash,
    intent: options.intent ?? '',
    phase: 'model',
    step: 0,
    tools: options.tools,
    trajectory: [],
    capabilities: [
      'inject',
      'mask_tools',
      'force_tool',
      'block',
      'human',
      ...(options.resolveModel ? ['swap_model' as const] : []),
    ],
  };
  let masked = new Set<string>();
  const prepareStep: PrepareStepFunction<ToolSet> = async ({
    steps,
    stepNumber,
    messages,
    model,
  }) => {
    ctx = {
      ...ctx,
      step: stepNumber,
      trajectory: trajectory(steps).slice(-1000),
      phase: 'model',
      model: typeof model === 'string' ? model : model.modelId,
    };
    const d = await runtime.evaluate(ctx);
    masked = new Set(d.masked_tools);
    const result: any = {};
    if (d.injection) result.messages = appendTail(messages, d);
    if (d.masked_tools.length) result.activeTools = options.tools.filter((t) => !masked.has(t));
    if (d.forced_tool) result.toolChoice = { type: 'tool', toolName: d.forced_tool };
    if (d.model && options.resolveModel) {
      try {
        result.model = options.resolveModel(d.model);
      } catch {
        /* Unsupported route fails open. */
      }
    }
    return result;
  };
  function wrapTools<T extends ToolSet>(tools: T): T {
    return Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [
        name,
        {
          ...t,
          ...(t.execute
            ? {
                execute: async (...args: any[]) => {
                  const d = await runtime.evaluate({
                    ...ctx,
                    phase: 'tool',
                    proposed: { tool: name, args: args[0] ?? {}, status: 'unknown' },
                  });
                  if (d.blocked || masked.has(name))
                    throw new MirrorsBlockedError(
                      d.human ??
                        d.evaluations.find((e) => e.outcome === 'fire')?.reason ??
                        'Tool masked for this step',
                    );
                  return (t.execute as any)(...args);
                },
              }
            : {}),
        },
      ]),
    ) as T;
  }
  function finish(event: { steps: any[] }) {
    runtime.finish({ ...ctx, trajectory: trajectory(event.steps).slice(-1000) });
  }
  return { prepareStep, wrapTools, finish };
}
