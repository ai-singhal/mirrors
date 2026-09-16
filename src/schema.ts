import { z } from 'zod';
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | {
      field: string;
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'exists';
      value?: unknown;
    };
export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(predicateSchema).min(1).max(50) }).strict(),
    z.object({ any: z.array(predicateSchema).min(1).max(50) }).strict(),
    z.object({ not: predicateSchema }).strict(),
    z
      .object({
        field: z.string().max(150),
        op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists']),
        value: z.unknown().optional(),
      })
      .strict(),
  ]),
);
export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('code'), when: predicateSchema }).strict(),
  z
    .object({
      type: z.literal('judgment'),
      question: z.string().min(1).max(4000),
      confidence: z.number().min(0).max(1).default(0.85),
      timeout_ms: z.number().int().min(10).max(10000).default(500),
    })
    .strict(),
]);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inject'), text: z.string().min(1).max(8000) }).strict(),
  z.object({ type: z.literal('mask_tools'), tools: z.array(z.string()).min(1) }).strict(),
  z.object({ type: z.literal('force_tool'), tool: z.string().min(1) }).strict(),
  z.object({ type: z.literal('block'), reason: z.string().min(1) }).strict(),
  z.object({ type: z.literal('swap_model'), model: z.string().min(1) }).strict(),
  z.object({ type: z.literal('human'), reason: z.string().min(1) }).strict(),
]);
export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    name: z.string().min(1).max(200),
    description: z.string().default(''),
    condition: conditionSchema,
    actions: z.array(actionSchema).min(1).max(10),
    status: z.enum(['off', 'shadow', 'active', 'retired']).default('shadow'),
    rollout: z.number().min(0).max(100).default(10),
    priority: z.number().int().min(-1000).max(1000).default(0),
    source: z
      .object({
        kind: z.enum(['manual', 'prompt', 'trace', 'pack', 'agent']),
        ref: z.string().optional(),
        line: z.number().optional(),
        commit: z.string().optional(),
      })
      .default({ kind: 'manual' }),
    pinned: z
      .object({ prompt_hash: z.string().optional(), model: z.string().optional() })
      .default({}),
    expiry: z
      .object({
        expires_at: z.string().datetime().optional(),
        idle_days: z.number().positive().optional(),
        no_lift_days: z.number().positive().optional(),
        override_limit: z.number().int().positive().optional(),
        min_runs: z.number().int().min(2).default(30),
      })
      .default({ min_runs: 30 }),
    failure: z.object({ class: z.string().min(1), when: predicateSchema }).optional(),
    owner: z.string().default('local'),
    notes: z.string().default(''),
    created_at: z
      .string()
      .datetime()
      .default(() => new Date().toISOString()),
  })
  .strict();
export const ledgerSchema = z
  .object({
    version: z.literal(1),
    name: z.string().default('My agent'),
    rules: z.array(ruleSchema).max(2000),
    budgets: z
      .array(
        z.object({
          failure_class: z.string(),
          ceiling_per_1k: z.number().min(0),
          min_runs: z.number().int().positive().default(30),
        }),
      )
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const r of v.rules) {
      if (seen.has(r.id)) ctx.addIssue({ code: 'custom', message: `Duplicate rule ID: ${r.id}` });
      seen.add(r.id);
    }
  });
export const toolEventSchema = z.object({
  id: z.string().optional(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['success', 'error', 'unknown', 'blocked']),
  error: z.string().optional(),
  timestamp: z.string().optional(),
});
export const contextSchema = z.object({
  session_id: z.string().min(1).max(200),
  step: z.number().int().nonnegative(),
  model: z.string(),
  prompt_hash: z.string().optional(),
  intent: z.string().default(''),
  phase: z.enum(['model', 'tool']).default('model'),
  tools: z.array(z.string()).default([]),
  trajectory: z.array(toolEventSchema).max(1000).default([]),
  proposed: toolEventSchema.optional(),
  capabilities: z
    .array(z.enum(['inject', 'mask_tools', 'force_tool', 'block', 'swap_model', 'human']))
    .optional(),
});
export type Rule = z.infer<typeof ruleSchema>;
export type Ledger = z.infer<typeof ledgerSchema>;
export type Context = z.infer<typeof contextSchema>;
export type ToolEvent = z.infer<typeof toolEventSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Trace = {
  id: string;
  model: string;
  timestamp: string;
  intent?: string;
  prompt_hash?: string;
  tools: ToolEvent[];
  failure_classes?: string[];
  source?: string;
};
export type Evaluation = {
  rule_id: string;
  status: Rule['status'];
  cohort: 'treatment' | 'control' | 'shadow' | 'none';
  matched: boolean | null;
  outcome: 'fire' | 'shadow' | 'control' | 'miss' | 'skipped' | 'suppressed';
  reason: string;
  actions: Action[];
};
export type Decision = {
  session_id: string;
  step: number;
  injection?: string;
  masked_tools: string[];
  forced_tool?: string;
  model?: string;
  blocked: boolean;
  human?: string;
  evaluations: Evaluation[];
  latency_ms: number;
  error?: string;
};
export type LogEvent = {
  id: string;
  timestamp: string;
  type: 'evaluation' | 'outcome' | 'label' | 'audit';
  session_id?: string;
  step?: number;
  rule_id?: string;
  rule_version?: string;
  model?: string;
  prompt_hash?: string;
  cohort?: Evaluation['cohort'];
  matched?: boolean | null;
  outcome?: Evaluation['outcome'];
  reason?: string;
  actions?: Action[];
  failure?: boolean;
  failure_class?: string;
  label?: 'correct' | 'incorrect' | 'override';
  target_id?: string;
  latency_ms?: number;
  data?: Record<string, unknown>;
};
