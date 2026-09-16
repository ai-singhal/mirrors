import { z } from 'zod';
export const callSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  args_hash: z.string(),
  status: z.enum(['success', 'error', 'unknown', 'blocked']),
  duration_ms: z.number().nonnegative().nullable().default(null),
  error_class: z.string().nullable().default(null),
  error: z.string().optional(),
  result: z.unknown().optional(),
  result_complete: z.boolean().optional(),
});
export const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  text: z.string().default(''),
  calls: z.array(callSchema).optional(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  result: z.unknown().optional(),
});
export const stepSchema = z.object({
  idx: z.number().int().nonnegative(),
  message_index: z.number().int().nullable().default(null),
  sys_hash: z.string().nullable().default(null),
  messages_hash: z.string().nullable().default(null),
  tools_hash: z.string().nullable().default(null),
  tool_calls: z.array(callSchema).default([]),
  final_message: z.string().default(''),
  duration_ms: z.number().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export const runSchema = z.object({
  id: z.string().min(1),
  version: z.string(),
  version_known: z.boolean().default(false),
  prompt_hash: z.string().nullable().default(null),
  code_ref: z.string().nullable().default(null),
  model: z.string().default('unknown'),
  intent: z.string().default('unclassified'),
  segment: z.string().default('all'),
  started_at: z.string(),
  completed: z.boolean().default(true),
  first_user_message: z.string().default(''),
  steps: z.array(stepSchema),
  messages: z.array(messageSchema).default([]),
  tool_definitions: z.array(z.any()).default([]),
  source: z.string(),
  raw: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type Run = z.infer<typeof runSchema>;
export type Call = z.infer<typeof callSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Message = z.infer<typeof messageSchema>;
export const fixSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  name: z.string().min(1).max(200),
  target_signal_id: z.string(),
  type: z.enum(['prompt', 'code', 'rule']),
  version_id: z.string().nullable().default(null),
  baseline_version: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  status: z.enum(['proposed', 'shipped', 'verified', 'retired']).default('proposed'),
  notes: z.string().default(''),
  source: z.string().default('manual'),
  rule_id: z.string().nullable().default(null),
  created_at: z.string().default(() => new Date().toISOString()),
});
export type Fix = z.infer<typeof fixSchema>;
export type Signal = {
  id: string;
  name: string;
  definition_text: string;
  kind: 'code' | 'judgment';
  threshold: number;
  detector: string;
  config: Record<string, unknown>;
  labeled_sample_path: string | null;
};
export type Hit = { step_idx: number; reason: string; confidence: number };
export type SignalResult = { assessable: boolean; hits: Hit[]; reason?: string };
