import { Runtime } from '../runtime.js';
import { Store } from '../store.js';
import type { Context, ToolEvent } from '../schema.js';
/** OpenClaw typed plugin hooks. Prompt hooks are turn-scoped on some harnesses. */
export function registerOpenClaw(api: {
  on: (name: string, handler: (event: any, context: any) => any) => void;
  pluginConfig?: { directory?: string; model?: string };
}) {
  const runtime = new Runtime(new Store(api.pluginConfig?.directory));
  const sessions = new Map<string, Context>();
  function context(e: any, c: any): Context | undefined {
    const id = c.sessionKey ?? c.sessionId ?? e.runId ?? c.runId;
    if (!id) return;
    let ctx = sessions.get(id);
    if (!ctx) {
      if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
      ctx = {
        session_id: id,
        model: e.model ?? c.model ?? api.pluginConfig?.model ?? 'unknown',
        intent: '',
        phase: 'model',
        step: 0,
        tools: [],
        trajectory: [],
        capabilities: ['inject', 'block', 'human'],
      };
      sessions.set(id, ctx);
    }
    return ctx;
  }
  api.on('before_prompt_build', async (e, c) => {
    const ctx = context(e, c);
    if (!ctx) return;
    runtime.reload();
    const names = (e.tools ?? []).map((t: any) => (typeof t === 'string' ? t : t.name));
    ctx.tools = names;
    const d = await runtime.evaluate({ ...ctx, phase: 'model' });
    return {
      ...(d.injection ? { appendContext: d.injection } : {}),
      ...(d.masked_tools.length && names.length
        ? { toolsAllow: names.filter((n: string) => !d.masked_tools.includes(n)) }
        : {}),
    };
  });
  api.on('before_tool_call', async (e, c) => {
    const ctx = context(e, c);
    if (!ctx) return;
    const d = await runtime.evaluate({
      ...ctx,
      phase: 'tool',
      proposed: { tool: e.toolName, args: e.params ?? {}, status: 'unknown' },
    });
    if (d.blocked)
      return {
        block: true,
        blockReason:
          d.human ??
          d.evaluations.find((x) => x.outcome === 'fire')?.reason ??
          'Mirrors intervention',
      };
  });
  api.on('after_tool_call', (e, c) => {
    const ctx = context(e, c);
    if (!ctx) return;
    ctx.trajectory.push({
      tool: e.toolName,
      args: e.params ?? {},
      status: e.error ? 'error' : 'success',
      error: e.error ? String(e.error) : undefined,
    });
    ctx.trajectory = ctx.trajectory.slice(-1000);
    ctx.step++;
  });
  api.on('agent_end', (e, c) => {
    const ctx = context(e, c);
    if (!ctx) return;
    runtime.finish(ctx);
    sessions.delete(ctx.session_id);
  });
}
export default { id: 'mirrors', name: 'Mirrors', register: registerOpenClaw };
