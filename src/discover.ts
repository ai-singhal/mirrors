import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, Engine, features, compilePredicate } from './engine.js';
import {
  ruleSchema,
  toolEventSchema,
  type Rule,
  type Trace,
  type ToolEvent,
  type Ledger,
  type Context,
} from './schema.js';
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export function draftRule(
  text: string,
  source: Rule['source'] = { kind: 'manual' },
  model?: string,
): Rule {
  const lower = text.toLowerCase();
  let when: any;
  let description = 'Draft judgment condition; review scope before activation.';
  if (
    /(same|identical|repeated).*(call|tool|argument|error)|retry.*(twice|two|three|3|2)/i.test(text)
  ) {
    when = {
      all: [
        { field: 'repeat_count', op: 'gte', value: /three|3/.test(lower) ? 3 : 2 },
        { field: 'last.status', op: 'eq', value: 'error' },
      ],
    };
    description =
      'Detects repeated identical tool arguments after an error; review the drafted threshold.';
  } else if (/tool.*(fails|error)|error.*tool|after.*fail/i.test(text)) {
    when = { field: 'last.status', op: 'eq', value: 'error' };
    description = 'Detects an error in the most recent tool result; review scope.';
  }
  const id =
    (text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'rule') +
    '-' +
    hash(text).slice(0, 6);
  return ruleSchema.parse({
    id,
    name: text.slice(0, 100),
    description,
    condition: when
      ? { type: 'code', when }
      : {
          type: 'judgment',
          question: `Does this instruction apply to the current trajectory and proposed next step? Instruction: ${text}`,
          confidence: 0.9,
          timeout_ms: 300,
        },
    actions: [{ type: 'inject', text }],
    status: 'shadow',
    source,
    pinned: model ? { model } : {},
  });
}
export function importPrompt(text: string, ref = 'prompt', model?: string) {
  return text.split(/\r?\n/).flatMap((line, i) => {
    const clean = line.trim().replace(/^[-*\d.)\s]+/, '');
    return /\b(if|when|whenever|unless|before|after|always|never|must|only if|on failure)\b/i.test(
      clean,
    )
      ? [
          {
            ...draftRule(clean, { kind: 'prompt', ref, line: i + 1 }, model),
            pinned: { prompt_hash: hash(text), ...(model ? { model } : {}) },
          },
        ]
      : [];
  });
}
export function archaeology(path: string) {
  const text = readFileSync(path, 'utf8');
  const rules = importPrompt(text, path);
  const history: { commit: string; date: string; subject: string }[] = [];
  const ages = new Map<number, { commit: string; date: string }>();
  let gitRoot: string | undefined;
  try {
    gitRoot = execFileSync('git', ['-C', resolve(path, '..'), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    const file = relative(gitRoot, resolve(path));
    const out = execFileSync(
      'git',
      ['-C', gitRoot, 'log', '--follow', '-100', '--format=%H%x09%aI%x09%s', '--', file],
      { encoding: 'utf8', maxBuffer: 5e6 },
    );
    for (const line of out.trim().split('\n').filter(Boolean)) {
      const [commit, date, ...subject] = line.split('\t');
      history.push({ commit, date, subject: subject.join('\t') });
    }
    const blame = execFileSync('git', ['-C', gitRoot, 'blame', '--line-porcelain', '--', file], {
      encoding: 'utf8',
      maxBuffer: 10e6,
    });
    let n = 0,
      commit = '',
      date = '';
    for (const line of blame.split('\n')) {
      const m = line.match(/^([a-f0-9]{40}) \d+ (\d+)/);
      if (m) {
        commit = m[1];
        n = +m[2];
      }
      if (line.startsWith('author-time '))
        date = new Date(Number(line.slice(12)) * 1000).toISOString();
      if (line.startsWith('\t')) ages.set(n, { commit, date });
    }
  } catch {
    /* Untracked prompts still have a useful report. */
  }
  const overlap: { a: string; b: string; kind: string; confidence: string }[] = [];
  const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const a = tokens(rules[i].name),
        b = tokens(rules[j].name);
      const common = [...a].filter((t) => b.has(t)).length;
      const score = common / Math.max(1, new Set([...a, ...b]).size);
      if (score > 0.45) {
        const neg = (s: string) => /\b(never|not|don't|avoid|block)\b/i.test(s);
        overlap.push({
          a: rules[i].id,
          b: rules[j].id,
          kind:
            neg(rules[i].name) !== neg(rules[j].name)
              ? 'possible contradiction'
              : 'possible overlap',
          confidence: 'lexical candidate; requires review',
        });
      }
    }
  return {
    file: path,
    prompt_hash: hash(text),
    estimated_tokens: estimateTokens(text),
    token_estimator: 'characters / 4; approximate',
    rule_count: rules.length,
    rules: rules.map((r) => ({ ...r, age: ages.get(r.source.line!) })),
    history,
    overlap,
    warning:
      'Heuristic extraction. Review conditions and overlap candidates; absence of a flag does not prove consistency.',
  };
}
function parseMaybe(x: any): any {
  if (typeof x === 'string') {
    try {
      return JSON.parse(x);
    } catch {
      return x;
    }
  }
  return x;
}
function attrs(xs: any): Record<string, any> {
  if (!Array.isArray(xs)) return xs ?? {};
  return Object.fromEntries(
    xs.map((x) => [
      x.key,
      x.value?.stringValue ??
        x.value?.intValue ??
        x.value?.boolValue ??
        x.value?.doubleValue ??
        x.value,
    ]),
  );
}
function timestamp(x: any): string {
  if (!x) return new Date(0).toISOString();
  if (typeof x === 'number') return new Date(x > 1e12 ? x : x * 1000).toISOString();
  const d = new Date(x);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(0).toISOString();
}
function fromMessages(obj: any, source: string): Trace | null {
  const messages = obj.messages ?? obj.conversation ?? [];
  if (!Array.isArray(messages)) return null;
  const calls: {
    id?: string;
    tool: string;
    args: any;
    status: ToolEvent['status'];
    error?: string;
    timestamp?: string;
  }[] = [];
  const results = new Map<string, any>();
  for (const m0 of messages) {
    const m = m0.message ?? m0;
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'tool')
      results.set(m.tool_call_id ?? m.metadata?.tool_call_id, parseMaybe(m.content));
    for (const b of blocks)
      if (b.type === 'tool_result')
        results.set(
          b.tool_use_id ?? b.tool_call_id,
          b.is_error
            ? { error: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) }
            : parseMaybe(b.content),
        );
  }
  for (const m0 of messages) {
    const m = m0.message ?? m0;
    const blocks = [...(Array.isArray(m.content) ? m.content : []), ...(m.tool_calls ?? [])];
    for (const b of blocks) {
      if (!['tool_call', 'tool_use', 'function', 'toolCall'].includes(b.type)) continue;
      const name = b.name ?? b.function?.name;
      if (!name) continue;
      const result = results.get(b.id);
      const bad =
        result?.status === 'error' ||
        result?.success === false ||
        result?.error ||
        b.execution?.status === 'error' ||
        b.resolved_outcome === 'error';
      const status: ToolEvent['status'] = bad
        ? 'error'
        : b.resolved_outcome === 'success' || result !== undefined
          ? 'success'
          : 'unknown';
      calls.push({
        id: b.id,
        tool: name,
        args: parseMaybe(b.input ?? b.arguments ?? b.function?.arguments ?? {}),
        status,
        error: bad
          ? String(result?.error ?? b.execution?.error ?? 'Tool returned an error')
          : undefined,
        timestamp: m.timestamp ?? m0.timestamp,
      });
    }
  }
  if (!calls.length) return null;
  return {
    id: obj.id ?? obj.conversation_id ?? obj.session_id ?? hash(source).slice(0, 16),
    model: obj.model ?? messages.find((m: any) => m.metadata?.model)?.metadata?.model ?? 'unknown',
    timestamp: timestamp(obj.timestamp ?? obj.date_range?.start ?? messages[0]?.timestamp),
    tools: calls.map((t) =>
      toolEventSchema.parse({
        ...t,
        args:
          typeof t.args === 'object' && t.args !== null && !Array.isArray(t.args)
            ? t.args
            : { value: t.args },
      }),
    ),
    source,
  };
}
export function normalizeExport(data: any, source = 'export'): Trace[] {
  if (Array.isArray(data)) {
    if (data.some((x) => x?.role || x?.message?.role))
      return normalizeExport({ messages: data }, source);
    return data.flatMap((x, i) => normalizeExport(x, source + ':' + i));
  }
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.tools) && data.tools.every((t: any) => typeof t.tool === 'string'))
    return [
      {
        ...data,
        id: String(data.id ?? hash(source).slice(0, 16)),
        timestamp: timestamp(data.timestamp),
        model: data.model ?? 'unknown',
        tools: data.tools.map((t: any) => toolEventSchema.parse(t)),
        source,
      },
    ];
  if (data.messages || data.conversation) {
    const t = fromMessages(data, source);
    return t ? [t] : [];
  }
  const spans =
    data.resourceSpans?.flatMap(
      (r: any) => r.scopeSpans?.flatMap((s: any) => s.spans ?? []) ?? [],
    ) ??
    data.spans ??
    data.observations ??
    data.rows;
  if (Array.isArray(spans)) {
    const groups = new Map<string, Trace>();
    for (const s of spans) {
      const a = attrs(s.attributes ?? s.metadata);
      const kind = String(
        s.type ?? a['openinference.span.kind'] ?? a['gen_ai.operation.name'] ?? '',
      ).toLowerCase();
      const name =
        a['gen_ai.tool.name'] ?? a['tool.name'] ?? (kind === 'tool' ? s.name : undefined);
      if (!name) continue;
      const id = String(s.traceId ?? s.trace_id ?? s.root_span_id ?? s.id ?? 'imported');
      const rawTime =
        s.startTime ??
        s.start_time ??
        s.created ??
        (s.startTimeUnixNano ? Number(BigInt(s.startTimeUnixNano) / 1000000n) : undefined);
      let t = groups.get(id);
      if (!t) {
        t = {
          id,
          model: a['gen_ai.request.model'] ?? a.model ?? 'unknown',
          timestamp: timestamp(rawTime),
          tools: [],
          source,
        };
        groups.set(id, t);
      }
      const args = parseMaybe(s.input ?? a['input.value'] ?? a['gen_ai.tool.call.arguments'] ?? {});
      t.tools.push(
        toolEventSchema.parse({
          id: s.id ?? s.spanId,
          tool: name,
          args:
            typeof args === 'object' && args !== null && !Array.isArray(args)
              ? args
              : { value: args },
          status:
            s.status?.code === 2 || s.level === 'ERROR' || s.error
              ? 'error'
              : s.endTime || s.endTimeUnixNano || s.output !== undefined
                ? 'success'
                : 'unknown',
          error: s.error ? String(s.error) : undefined,
          timestamp: timestamp(rawTime),
        }),
      );
    }
    return [...groups.values()].map((t) => ({
      ...t,
      tools: t.tools.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')),
    }));
  }
  for (const key of ['traces', 'sessions', 'data', 'events'])
    if (Array.isArray(data[key])) return normalizeExport(data[key], source);
  return [];
}
export function importTraces(path: string): { traces: Trace[]; warnings: string[] } {
  const traces: Trace[] = [],
    warnings: string[] = [];
  const files: string[] = [];
  function walk(p: string) {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p)) {
        if (n === 'node_modules' || n.startsWith('.')) continue;
        walk(join(p, n));
      }
    } else if (/\.jsonl?$/.test(p)) files.push(p);
  }
  walk(path);
  for (const file of files) {
    try {
      const text = readFileSync(file, 'utf8');
      const data = file.endsWith('.jsonl')
        ? text
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : JSON.parse(text);
      const found = normalizeExport(data, file);
      if (!found.length) warnings.push(`${file}: no recognizable tool events`);
      traces.push(...found);
    } catch (e) {
      warnings.push(`${file}: ${String(e)}`);
    }
  }
  return { traces, warnings };
}
export function backtest(ledger: Ledger, traces: Trace[], days = 30) {
  const engine = new Engine(ledger);
  const eligible = traces.filter((t) => Date.parse(t.timestamp) >= Date.now() - days * 86400000);
  return ledger.rules.map((r) => {
    let occurrences = 0,
      failures = 0,
      runs = 0;
    const examples: { trace_id: string; step: number }[] = [];
    if (r.condition.type === 'judgment')
      return {
        rule_id: r.id,
        verdict: 'cannot assess',
        reason:
          'Judgment conditions require an explicitly configured judge; offline replay skips them.',
        runs: eligible.length,
        occurrences: 0,
        failures: null,
      };
    const test = compilePredicate(r.condition.when);
    for (const t of eligible) {
      let hit = false,
        bad = false;
      for (let i = 0; i < t.tools.length; i++) {
        const ctx: Context = {
          session_id: t.id,
          step: i,
          model: t.model,
          phase: 'tool',
          intent: t.intent ?? '',
          prompt_hash: t.prompt_hash,
          trajectory: t.tools.slice(0, i),
          proposed: t.tools[i],
          tools: [...new Set(t.tools.map((x) => x.tool))],
        };
        if (test(features(ctx))) {
          occurrences++;
          hit = true;
          if (examples.length < 5) examples.push({ trace_id: t.id, step: i });
          if (
            engine.failure(r, { ...ctx, trajectory: t.tools.slice(0, i + 1), proposed: undefined })
          )
            bad = true;
        }
      }
      if (hit) runs++;
      if (bad) failures++;
    }
    return {
      rule_id: r.id,
      verdict: eligible.length && !occurrences ? 'dead weight' : 'cannot assess',
      reason: occurrences
        ? 'Historical situations found. Replay cannot establish intervention lift.'
        : eligible.length
          ? 'No matching situation in this sample.'
          : 'No dated traces in this window.',
      runs: eligible.length,
      matched_runs: runs,
      occurrences,
      situation_rate: eligible.length ? runs / eligible.length : null,
      failures: r.failure ? failures : null,
      failure_per_1k_matched: r.failure && runs ? (failures / runs) * 1000 : null,
      examples,
    };
  });
}
export function propose(traces: Trace[]) {
  const groups = new Map<
    string,
    { count: number; evidence: { trace_id: string; step: number }[] }
  >();
  for (const t of traces)
    for (let i = 0; i < t.tools.length; i++) {
      const e = t.tools[i];
      if (e.status !== 'error') continue;
      const key =
        e.tool + ':' + (e.error ?? 'error').replace(/\b[0-9a-f]{8,}\b|\d+/gi, '#').slice(0, 100);
      const g = groups.get(key) ?? { count: 0, evidence: [] };
      g.count++;
      if (g.evidence.length < 5) g.evidence.push({ trace_id: t.id, step: i });
      groups.set(key, g);
    }
  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([key, g]) => ({
      rule: ruleSchema.parse({
        ...draftRule(
          `After ${key.split(':')[0]} fails, inspect its result and current state before retrying.`,
          { kind: 'trace', ref: g.evidence[0]?.trace_id },
        ),
        id: 'failure-' + hash(key).slice(0, 10),
        notes: `Draft from ${g.count} error events. Human review required.`,
        condition: {
          type: 'code',
          when: {
            all: [
              { field: 'last.tool', op: 'eq', value: key.split(':')[0] },
              { field: 'last.status', op: 'eq', value: 'error' },
            ],
          },
        },
      }),
      ...g,
    }));
}
