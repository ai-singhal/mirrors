import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  ledgerSchema,
  type Predicate,
  type Context,
  type Ledger,
  type Rule,
  type Decision,
  type Evaluation,
  type ToolEvent,
} from './schema.js';
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return (
    '{' +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}
export const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : stableStringify(v))
    .digest('hex');
export function features(ctx: Context) {
  const trajectory = ctx.trajectory.slice(-100);
  const last = trajectory.at(-1);
  let repeat_count = 0,
    consecutive_errors = 0;
  const anchor = ctx.proposed ?? last;
  if (anchor) {
    const h = hash(anchor.args);
    for (let i = trajectory.length - 1; i >= 0; i--) {
      const t = trajectory[i];
      if (t.tool !== anchor.tool || hash(t.args) !== h) break;
      repeat_count++;
    }
  }
  for (let i = trajectory.length - 1; i >= 0 && trajectory[i].status === 'error'; i--)
    consecutive_errors++;
  return {
    ...ctx,
    trajectory,
    last: last ? { ...last, args_hash: hash(last.args) } : undefined,
    repeat_count,
    consecutive_errors,
    step: ctx.step,
  };
}
function get(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const k of path.split('.')) {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) return undefined;
    cur = cur?.[k];
  }
  return cur;
}
export function compilePredicate(p: Predicate, depth = 0): (f: unknown) => boolean {
  if (depth > 16) throw new Error('Condition nesting exceeds 16');
  if ('all' in p) {
    const fs = p.all.map((x) => compilePredicate(x, depth + 1));
    return (f) => fs.every((x) => x(f));
  }
  if ('any' in p) {
    const fs = p.any.map((x) => compilePredicate(x, depth + 1));
    return (f) => fs.some((x) => x(f));
  }
  if ('not' in p) {
    const fn = compilePredicate(p.not, depth + 1);
    return (f) => !fn(f);
  }
  return (f) => {
    const a = get(f, p.field),
      b = p.value;
    switch (p.op) {
      case 'exists':
        return a !== undefined && a !== null;
      case 'eq':
        return a === b;
      case 'ne':
        return a !== undefined && a !== b;
      case 'gt':
        return typeof a === 'number' && typeof b === 'number' && a > b;
      case 'gte':
        return typeof a === 'number' && typeof b === 'number' && a >= b;
      case 'lt':
        return typeof a === 'number' && typeof b === 'number' && a < b;
      case 'lte':
        return typeof a === 'number' && typeof b === 'number' && a <= b;
      case 'contains':
        return typeof a === 'string' && typeof b === 'string'
          ? a.toLowerCase().includes(b.toLowerCase())
          : Array.isArray(a) && a.includes(b);
      case 'in':
        return Array.isArray(b) && b.includes(a);
    }
  };
}
export function cohort(rule: Rule, session: string): 'treatment' | 'control' {
  return (parseInt(hash(rule.id + '\0' + session).slice(0, 8), 16) / 0x100000000) * 100 <
    rule.rollout
    ? 'treatment'
    : 'control';
}
export const ruleVersion = (r: Rule) => hash(r).slice(0, 16);
export type Judge = (
  question: string,
  ctx: Context,
  signal: AbortSignal,
) => Promise<{ answer: boolean; confidence: number }>;
export function emptyDecision(ctx: Context, error?: string): Decision {
  return {
    session_id: ctx.session_id,
    step: ctx.step,
    masked_tools: [],
    blocked: false,
    evaluations: [],
    latency_ms: 0,
    ...(error ? { error } : {}),
  };
}
export function supportsRule(r: Rule, ctx: Context) {
  return r.actions.some(
    (a) =>
      (!ctx.capabilities || ctx.capabilities.includes(a.type)) &&
      (['block', 'human'].includes(a.type) ? ctx.phase === 'tool' : ctx.phase === 'model'),
  );
}
export class Engine {
  readonly ledger: Ledger;
  private compiled: Map<string, (f: unknown) => boolean> = new Map();
  constructor(input: unknown) {
    this.ledger = ledgerSchema.parse(input);
    this.ledger.rules.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    for (const r of this.ledger.rules) {
      if (r.condition.type === 'code') this.compiled.set(r.id, compilePredicate(r.condition.when));
      if (r.failure) compilePredicate(r.failure.when);
    }
  }
  evaluate(ctx: Context, judgments: Map<string, boolean | null> = new Map()): Decision {
    const start = performance.now();
    const d = emptyDecision(ctx);
    try {
      const f = features(ctx);
      for (const r of this.ledger.rules) {
        if (r.status === 'off' || r.status === 'retired') continue;
        if (!supportsRule(r, ctx)) {
          d.evaluations.push({
            rule_id: r.id,
            status: r.status,
            cohort: 'none',
            matched: null,
            outcome: 'skipped',
            reason: 'No supported action in this phase',
            actions: [],
          });
          continue;
        }
        const mismatch = !!(
          (r.pinned.model && r.pinned.model !== ctx.model) ||
          (r.pinned.prompt_hash && r.pinned.prompt_hash !== ctx.prompt_hash)
        );
        const expired = !!r.expiry.expires_at && Date.parse(r.expiry.expires_at) < Date.now();
        const mode = expired ? 'off' : mismatch ? 'shadow' : r.status;
        const arm =
          mode === 'active' ? cohort(r, ctx.session_id) : mode === 'shadow' ? 'shadow' : 'none';
        const matched = expired
          ? false
          : r.condition.type === 'code'
            ? this.compiled.get(r.id)!(f)
            : (judgments.get(r.id) ?? null);
        const e: Evaluation = {
          rule_id: r.id,
          status: mode,
          cohort: arm,
          matched,
          outcome:
            matched === null
              ? 'skipped'
              : !matched
                ? 'miss'
                : arm === 'shadow'
                  ? 'shadow'
                  : arm === 'control'
                    ? 'control'
                    : 'suppressed',
          reason: expired
            ? 'Rule expired'
            : mismatch
              ? 'Model or prompt changed; automatically shadowed'
              : matched === null
                ? 'Judgment unavailable or below confidence'
                : matched
                  ? 'Condition matched'
                  : 'Condition not met',
          actions: [],
        };
        if (matched && arm === 'treatment') {
          for (const a of r.actions) {
            if (ctx.capabilities && !ctx.capabilities.includes(a.type)) continue;
            switch (a.type) {
              case 'inject':
                if (ctx.phase === 'model' && !d.injection) {
                  d.injection = a.text;
                  e.actions.push(a);
                }
                break;
              case 'mask_tools':
                if (ctx.phase === 'model') {
                  d.masked_tools.push(...a.tools);
                  e.actions.push(a);
                }
                break;
              case 'force_tool':
                if (ctx.phase === 'model' && !d.forced_tool && ctx.tools.includes(a.tool)) {
                  d.forced_tool = a.tool;
                  e.actions.push(a);
                }
                break;
              case 'swap_model':
                if (ctx.phase === 'model' && !d.model) {
                  d.model = a.model;
                  e.actions.push(a);
                }
                break;
              case 'block':
                if (ctx.phase === 'tool') {
                  d.blocked = true;
                  e.actions.push(a);
                }
                break;
              case 'human':
                if (ctx.phase === 'tool') {
                  d.blocked = true;
                  d.human ??= a.reason;
                  e.actions.push(a);
                }
                break;
            }
          }
          e.outcome = e.actions.length ? 'fire' : 'suppressed';
          e.reason = e.actions.length
            ? e.actions
                .map((a) =>
                  a.type === 'inject'
                    ? 'Added a tail reminder'
                    : a.type === 'block'
                      ? `Blocked call: ${a.reason}`
                      : a.type === 'mask_tools'
                        ? `Masked ${a.tools.join(', ')}`
                        : a.type === 'force_tool'
                          ? `Forced ${a.tool}`
                          : a.type === 'swap_model'
                            ? `Selected ${a.model}`
                            : `Queued human review: ${a.reason}`,
                )
                .join('; ')
            : 'No applicable action in this phase, tool unavailable, or higher-priority action won';
        }
        d.evaluations.push(e);
      }
      d.masked_tools = [...new Set(d.masked_tools)];
      if (d.forced_tool && d.masked_tools.includes(d.forced_tool)) {
        const forced = d.forced_tool;
        delete d.forced_tool;
        for (const e of d.evaluations) {
          e.actions = e.actions.filter((a) => a.type !== 'force_tool' || a.tool !== forced);
          if (e.outcome === 'fire' && !e.actions.length) {
            e.outcome = 'suppressed';
            e.reason = 'Forced tool is masked; restriction wins';
          }
        }
      }
      d.latency_ms = performance.now() - start;
      return d;
    } catch (err) {
      return { ...emptyDecision(ctx, String(err)), latency_ms: performance.now() - start };
    }
  }
  async evaluateAsync(ctx: Context, judge?: Judge): Promise<Decision> {
    const start = performance.now();
    const answers = new Map<string, boolean | null>();
    if (judge)
      await Promise.all(
        this.ledger.rules
          .filter(
            (r) =>
              r.condition.type === 'judgment' &&
              supportsRule(r, ctx) &&
              ['active', 'shadow'].includes(r.status) &&
              (!r.expiry.expires_at || Date.parse(r.expiry.expires_at) >= Date.now()),
          )
          .slice(0, 8)
          .map(async (r) => {
            if (r.condition.type !== 'judgment') return;
            const c = r.condition;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const response = await Promise.race([
                judge(c.question, ctx, controller.signal),
                new Promise<null>((resolve) => {
                  timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                  }, c.timeout_ms);
                }),
              ]);
              answers.set(
                r.id,
                response &&
                  Number.isFinite(response.confidence) &&
                  response.confidence >= c.confidence &&
                  typeof response.answer === 'boolean'
                  ? response.answer
                  : null,
              );
            } catch {
              answers.set(r.id, null);
            } finally {
              clearTimeout(timer);
            }
          }),
      );
    const d = this.evaluate(ctx, answers);
    d.latency_ms = performance.now() - start;
    return d;
  }
  failure(rule: Rule, ctx: Context): boolean | null {
    try {
      return rule.failure ? compilePredicate(rule.failure.when)(features(ctx)) : null;
    } catch {
      return null;
    }
  }
}
export function appendTail<T extends { role: string; content: unknown }>(
  messages: T[],
  d: Decision,
): Array<T | { role: 'user'; content: string }> {
  return d.injection
    ? [...messages, { role: 'user', content: `[Mirrors: step-specific guidance]\n${d.injection}` }]
    : messages;
}
export function explain(d: Decision) {
  return d.evaluations
    .filter((e) => e.matched)
    .map((e) => `${d.session_id} step ${d.step} · ${e.rule_id} · ${e.outcome}: ${e.reason}`);
}
