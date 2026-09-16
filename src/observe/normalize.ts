import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from '../engine.js';
import { normalizeExport } from '../discover.js';
import { runSchema, type Run, type Call, type Message } from './schema.js';
export type IngestOptions = {
  version?: string;
  model?: string;
  intent?: string;
  segment?: string;
  promptHash?: string;
  codeRef?: string;
};
const decode = (v: any): any => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};
const textOf = (v: any): string =>
  typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v
          .filter((b) => b.type === 'text' || b.type === 'output_text' || b.type === 'user_message')
          .map((b) => b.text ?? b.userText ?? '')
          .join('\n')
      : '';
function time(v: any) {
  if (!v) return new Date(0).toISOString();
  if (typeof v === 'object' && v.$date) v = v.$date;
  if (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v) &&
    !/(Z|[+-]\d{2}:?\d{2})$/.test(v)
  )
    v = v.replace(' ', 'T') + 'Z';
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}
export function errorClass(error: string) {
  if (
    /node|selector|old_string|target\.id|target id|invalid.*target|target.*not found/i.test(error)
  )
    return 'invalid-target';
  if (/not loaded|load.*tool|unknown tool|must call get_tool/i.test(error))
    return 'tool-unavailable';
  if (/timeout|timed out/i.test(error)) return 'timeout';
  if (/429|rate.limit/i.test(error)) return 'rate-limit';
  if (/401|403|unauthor|permission|forbidden/i.test(error)) return 'permission';
  if (/schema|argument|parameter|validation|missing required/i.test(error))
    return 'invalid-arguments';
  return 'tool-error';
}
function makeCall(v: any, result: any, isError = false): Call {
  const raw = decode(v.input ?? v.arguments ?? v.args ?? v.function?.arguments ?? {});
  const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
  const r = decode(result);
  const error =
    v.error ??
    v.execution?.error ??
    (r && typeof r === 'object'
      ? (r.error ?? (r.success === false ? r.message : undefined))
      : undefined);
  const errorValue = error ?? (textOf(result) || JSON.stringify(result) || 'Tool error');
  const errorText = typeof errorValue === 'string' ? errorValue : JSON.stringify(errorValue);
  const bad =
    isError ||
    !!error ||
    v.status === 'error' ||
    v.resolved_outcome === 'error' ||
    v.execution?.status === 'error' ||
    r?.status === 'error';
  return {
    id: String(v.id ?? v.tool_call_id ?? hash(v).slice(0, 12)),
    name: String(v.name ?? v.tool ?? v.function?.name),
    args,
    args_hash: hash(args),
    status: bad
      ? 'error'
      : v.status === 'blocked'
        ? 'blocked'
        : v.status === 'success' || v.resolved_outcome === 'success' || result !== undefined
          ? 'success'
          : 'unknown',
    duration_ms:
      typeof v.duration_ms === 'number'
        ? v.duration_ms
        : typeof v.execution?.startTime === 'number' && typeof v.execution?.endTime === 'number'
          ? Math.max(0, v.execution.endTime - v.execution.startTime)
          : null,
    error_class: bad ? errorClass(errorText) : null,
    ...(bad ? { error: errorText } : {}),
    ...(result !== undefined ? { result: r } : {}),
  };
}
export function normalizeRuns(data: any, source = 'export', options: IngestOptions = {}): Run[] {
  if (Array.isArray(data)) {
    if (data.some((x) => x?.role || x?.message?.role))
      return normalizeRuns({ messages: data }, source, options);
    return data.flatMap((x, i) => normalizeRuns(x, source + ':' + i, options));
  }
  if (!data || typeof data !== 'object') return [];
  if (data.steps && data.version && data.source) {
    const r = runSchema.parse(data);
    return [
      {
        ...r,
        ...(options.version ? { version: options.version, version_known: true } : {}),
        ...(options.intent ? { intent: options.intent } : {}),
        ...(options.segment ? { segment: options.segment } : {}),
      },
    ];
  }
  for (const key of ['conversations', 'sessions', 'traces', 'data', 'events'])
    if (Array.isArray(data[key])) return normalizeRuns(data[key], source, options);
  const spans =
    data.resourceSpans?.flatMap(
      (r: any) => r.scopeSpans?.flatMap((s: any) => s.spans ?? []) ?? [],
    ) ??
    data.spans ??
    data.observations ??
    data.rows;
  if (Array.isArray(spans)) {
    const attrs = (xs: any): Record<string, any> =>
      Array.isArray(xs)
        ? Object.fromEntries(
            xs.map((x) => [
              x.key,
              x.value?.stringValue ?? x.value?.intValue ?? x.value?.boolValue ?? x.value,
            ]),
          )
        : (xs ?? {});
    return normalizeExport(data, source).flatMap((trace) => {
      const own = spans.filter(
        (s: any) =>
          String(s.traceId ?? s.trace_id ?? s.root_span_id ?? s.id ?? 'imported') === trace.id,
      );
      const metadata = Object.assign(
        {},
        data.metadata ?? {},
        ...own.map((s: any) => attrs(s.attributes ?? s.metadata)),
      );
      const enriched = {
        ...trace,
        version: data.version ?? metadata.version ?? metadata['service.version'],
        prompt_hash: data.prompt_hash ?? metadata.prompt_hash ?? metadata['gen_ai.prompt.hash'],
        code_ref: data.code_ref ?? metadata.code_ref,
        intent: data.intent ?? metadata.intent,
        segment: data.segment ?? metadata.segment,
        tools: trace.tools.map((tool, index) => {
          const span = own.find((s: any) => String(s.id ?? s.spanId) === tool.id) ?? own[index];
          const a = attrs(span?.attributes ?? span?.metadata);
          const output = span?.output ?? a['output.value'];
          const start = span?.startTimeUnixNano
            ? Number(BigInt(span.startTimeUnixNano) / 1000000n)
            : Date.parse(span?.startTime ?? span?.start_time);
          const end = span?.endTimeUnixNano
            ? Number(BigInt(span.endTimeUnixNano) / 1000000n)
            : Date.parse(span?.endTime ?? span?.end_time);
          return {
            ...tool,
            result: decode(output),
            duration_ms:
              Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null,
          };
        }),
      };
      return normalizeRuns(enriched, source + ':' + trace.id, options).map((run) => ({
        ...run,
        raw: { ...data, source_trace_id: trace.id },
      }));
    });
  }
  const rawMessages = data.messages ?? data.conversation;
  const metadata = data.metadata ?? {};
  const rawModel =
    options.model ??
    data.model ??
    metadata.model ??
    rawMessages?.find((m: any) => m.metadata?.model)?.metadata?.model ??
    'unknown';
  const model = typeof rawModel === 'string' ? rawModel : (rawModel.id ?? 'unknown');
  const messages: Message[] = [];
  const steps: Run['steps'] = [];
  const definitions = Array.isArray(data.tool_definitions)
    ? data.tool_definitions
    : Array.isArray(data.tools) && data.tools.some((t: any) => t.type === 'function')
      ? data.tools
      : [];
  if (Array.isArray(rawMessages)) {
    const results = new Map<string, { value: any; error: boolean; complete?: boolean }>();
    for (const original of rawMessages) {
      const m = original.message ?? original;
      const blocks = Array.isArray(m.content) ? m.content : [];
      if (m.role === 'tool')
        results.set(String(m.tool_call_id ?? m.metadata?.tool_call_id), {
          value: decode(typeof m.content === 'string' ? m.content : textOf(m.content)),
          error: !!m.is_error,
        });
      for (const b of blocks)
        if (b.type === 'tool_result')
          results.set(String(b.tool_use_id ?? b.tool_call_id), {
            value: decode(b.content),
            error: !!b.is_error,
            complete: !b.truncated,
          });
    }
    for (const original of rawMessages) {
      const m = original.message ?? original;
      if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) continue;
      const blocks = Array.isArray(m.content) ? m.content : [];
      const calls = [...blocks, ...(m.tool_calls ?? [])]
        .filter((b) => ['tool_call', 'tool_use', 'function', 'toolCall'].includes(b.type))
        .map((b) => {
          const result = results.get(String(b.id)) ?? results.get(String(b.providerToolCallId));
          return {
            ...makeCall(b, result?.value, result?.error),
            result_complete: result?.complete ?? result?.value !== undefined,
          };
        });
      if (m.role === 'tool') {
        const id = String(m.tool_call_id ?? m.metadata?.tool_call_id);
        const c = steps.flatMap((s) => s.tool_calls).find((c) => c.id === id);
        messages.push({
          role: 'tool',
          text: '',
          tool_call_id: id,
          tool_name: c?.name ?? m.name ?? 'unknown',
          result: results.get(id)?.value,
        });
        continue;
      }
      const text = textOf(m.content ?? m.text);
      if (text || m.role === 'assistant' || calls.length) {
        const msg: Message = { role: m.role, text, ...(calls.length ? { calls } : {}) };
        if (m.role === 'assistant')
          steps.push({
            idx: steps.length,
            message_index: messages.length,
            metadata: m.metadata ?? {},
            sys_hash: hash(messages.filter((x) => x.role === 'system')),
            messages_hash: hash(messages),
            tools_hash: definitions.length ? hash(definitions) : null,
            tool_calls: calls,
            final_message: text,
            duration_ms: typeof m.duration_ms === 'number' ? m.duration_ms : null,
          });
        messages.push(msg);
      }
      for (const b of blocks)
        if (b.type === 'tool_result') {
          const id = String(b.tool_use_id ?? b.tool_call_id);
          const c = steps.flatMap((s) => s.tool_calls).find((c) => c.id === id);
          messages.push({
            role: 'tool',
            text: '',
            tool_call_id: id,
            tool_name: c?.name ?? 'unknown',
            result: results.get(id)?.value,
          });
        }
    }
  } else {
    const traces =
      Array.isArray(data.tools) && data.tools.every((t: any) => typeof t.tool === 'string')
        ? [{ ...data, tools: data.tools }]
        : normalizeExport(data, source);
    if (!traces.length) return [];
    if (traces.length > 1)
      return traces.flatMap((t) => normalizeRuns(t, source + ':' + t.id, options));
    for (const [index, t] of traces[0].tools.entries()) {
      const original = data.tools?.[index] ?? t;
      const c = makeCall({ ...t, ...original }, original.result);
      steps.push({
        idx: steps.length,
        message_index: null,
        sys_hash: null,
        messages_hash: null,
        tools_hash: null,
        tool_calls: [c],
        final_message: '',
        duration_ms: c.duration_ms,
      });
    }
  }
  if (!steps.length && !messages.length) return [];
  const system = messages.filter((m) => m.role === 'system');
  const prompt_hash =
    options.promptHash ??
    data.prompt_hash ??
    metadata.prompt_hash ??
    (system.length ? hash(system) : null);
  const code_ref =
    options.codeRef ?? data.code_version ?? data.code_ref ?? metadata.code_ref ?? null;
  const explicit =
    options.version ?? data.version ?? metadata.version ?? data.release ?? metadata.release;
  const version = String(
    explicit ??
      (prompt_hash || code_ref
        ? 'v-' + hash({ prompt_hash, code_ref, model }).slice(0, 12)
        : 'unversioned:' + model),
  );
  const id = String(
    data.id ??
      data.conversation_id ??
      data.session_id ??
      data.trace_id ??
      data._id?.$oid ??
      data._id ??
      hash({ source, messages, steps }).slice(0, 20),
  );
  return [
    runSchema.parse({
      id,
      version,
      version_known: !!(explicit || prompt_hash || code_ref),
      prompt_hash,
      code_ref,
      model,
      intent: options.intent ?? data.intent ?? metadata.intent ?? 'unclassified',
      segment:
        options.segment ?? data.segment ?? metadata.segment ?? data.professional_domain ?? 'all',
      started_at: time(
        data.started_at ??
          data.timestamp ??
          data.created_at ??
          data.date_range?.start ??
          rawMessages?.[0]?.timestamp,
      ),
      completed: data.completed ?? !['running', 'interrupted'].includes(data.status),
      first_user_message: messages.find((m) => m.role === 'user')?.text ?? data.intent ?? '',
      steps,
      messages,
      tool_definitions: definitions,
      source,
      raw: data,
      metadata: { imported_format: rawMessages ? 'messages' : 'tool-spans', ...metadata },
    }),
  ];
}
export function readExports(path: string, options: IngestOptions = {}) {
  const runs: Run[] = [],
    warnings: string[] = [];
  const files: string[] = [];
  const visit = (p: string) => {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p))
        if (!n.startsWith('.') && n !== 'node_modules') visit(join(p, n));
    } else if (/\.jsonl?$/i.test(p)) files.push(p);
  };
  visit(path);
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      const data = file.endsWith('.jsonl')
        ? text
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : JSON.parse(text);
      const found = normalizeRuns(data, file, options);
      if (!found.length) warnings.push(`${file}: no supported runs`);
      runs.push(...found);
    } catch (e) {
      warnings.push(`${file}: ${String(e)}`);
    }
  }
  return { runs, warnings };
}
