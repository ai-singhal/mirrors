#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { Engine, ruleVersion, hash } from './engine.js';
import { ruleSchema, contextSchema } from './schema.js';
import { starterLedger } from './packs.js';
import {
  importPrompt,
  importTraces,
  archaeology,
  backtest,
  draftRule,
  propose,
  estimateTokens,
} from './discover.js';
import { metrics, digest, budgetBreaches, lifecycle } from './metrics.js';
import { startServer } from './server.js';
import { startProxy } from './proxy.js';
import {
  flaggedProposals,
  flagFailure,
  reviewQueue,
  resolveReview,
  recordPrompt,
  promptSavings,
} from './workflows.js';
import { createDemo } from './demo.js';
const cli = new Command()
  .name('mirrors')
  .description(
    'Every agent rule gets a condition, a fire count, a recurrence number, and a switch.',
  )
  .version('0.1.0')
  .option('--cwd <directory>', 'project directory', process.cwd());
const store = () => new Store(cli.opts().cwd);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
function addRules(rules: any[]) {
  let added = 0;
  store().update((v) => {
    for (const r of rules)
      if (!v.rules.some((x) => x.id === r.id)) {
        v.rules.push(r);
        added++;
      }
    return v;
  });
  return added;
}
cli
  .command('init')
  .description('Create a ledger; all starter rules are silent in shadow')
  .option('--empty', 'start without rule packs')
  .action((o) => {
    const v = starterLedger();
    if (o.empty) v.rules = [];
    store().init(v);
    console.log(`Created ${store().path}. ${v.rules.length} rules in shadow.\nNext: mirrors serve`);
  });
cli.command('validate').action(() => {
  const engine = new Engine(store().read());
  console.log(`Valid ledger: ${engine.ledger.rules.length} rules.`);
});
cli
  .command('add <instruction>')
  .description('Draft a scoped rule, always in shadow')
  .option('--model <id>')
  .action((text, o) => {
    const r = draftRule(text, { kind: 'manual' }, o.model);
    if (!addRules([r])) throw new Error('Rule already exists');
    console.log(stringify(r));
  });
cli
  .command('list')
  .option('--json')
  .action((o) => {
    const v = store().read();
    if (o.json) print(v.rules);
    else
      console.table(
        v.rules.map((r) => ({
          id: r.id,
          status: r.status,
          condition: r.condition.type,
          rollout: r.rollout,
          priority: r.priority,
          name: r.name,
        })),
      );
  });
cli
  .command('set <id> <status>')
  .option('--rollout <percent>')
  .action((id, status, o) => {
    store().update((v) => {
      const r = v.rules.find((r) => r.id === id);
      if (!r) throw new Error('Unknown rule');
      Object.assign(
        r,
        ruleSchema.parse({
          ...r,
          status,
          ...(o.rollout !== undefined ? { rollout: Number(o.rollout) } : {}),
        }),
      );
      return v;
    });
    console.log(`${id} → ${status}`);
  });
const imp = cli
  .command('import')
  .description('Import candidates or traces without activating rules');
imp
  .command('prompt <file>')
  .option('--model <id>')
  .action((file, o) => {
    const path = resolve(cli.opts().cwd, file);
    const rules = importPrompt(readFileSync(path, 'utf8'), file, o.model);
    console.log(`Imported ${addRules(rules)} shadow candidates. Conditions need human review.`);
  });
imp.command('traces <path>').action((path) => {
  const result = importTraces(resolve(cli.opts().cwd, path));
  store().saveTraces(result.traces);
  print({ imported: result.traces.length, warnings: result.warnings });
  if (!result.traces.length) process.exitCode = 1;
});
cli
  .command('archaeology <prompt>')
  .option('--output <file>')
  .action((path, o) => {
    const report = archaeology(resolve(cli.opts().cwd, path));
    if (o.output) writeFileSync(resolve(cli.opts().cwd, o.output), JSON.stringify(report, null, 2));
    else print(report);
  });
cli
  .command('backtest')
  .option('--days <n>', 'dated trace window', '30')
  .action((o) => {
    print(backtest(store().read(), store().traces(), Number(o.days)));
  });
cli
  .command('report')
  .option('--days <n>', 'measurement window', '30')
  .action((o) =>
    print({
      rules: metrics(store().read(), store().events(), Number(o.days)),
      budgets: budgetBreaches(store().read(), store().events(), Number(o.days)),
    }),
  );
cli
  .command('propose')
  .option('--all-errors', 'include unflagged tool errors')
  .option('--apply', 'add drafts in shadow')
  .action((o) => {
    const drafts = flaggedProposals(store(), !!o.allErrors);
    if (o.apply) console.log(`Added ${addRules(drafts.map((d) => d.rule))} shadow rules.`);
    else print(drafts);
  });
cli
  .command('flag <traceId>')
  .option('--note <text>', 'failure description', 'Flagged by a human')
  .action((id, o) => {
    print(flagFailure(store(), id, o.note));
  });
cli.command('queue').action(() => print(reviewQueue(store().events())));
cli.command('review <eventId> <decision>').action((id, decision) => {
  if (!['approved', 'denied'].includes(decision)) throw new Error('Use approved or denied');
  print(resolveReview(store(), id, decision));
});
cli
  .command('prompt-snapshot <file>')
  .description('Record an estimated prompt token count; does not store prompt text')
  .action((file) => {
    recordPrompt(store(), resolve(cli.opts().cwd, file));
    print(promptSavings(store().events()));
  });
cli
  .command('ask-agent <traceId>')
  .description('Send a stored failed trace to its original model; explicit network call')
  .option('--model <id>', 'override unavailable original model')
  .action(async (id, o) => {
    const t = store()
      .traces()
      .find((t) => t.id === id);
    if (!t) throw new Error('Unknown trace');
    if (!o.model && t.model === 'unknown')
      throw new Error('Original model is unknown; specify --model');
    const { askAgent, configuredModel } = await import('./judge.js');
    const suggestion = await askAgent(t, configuredModel(o.model ?? t.model));
    const rule = draftRule(suggestion.instruction, { kind: 'agent', ref: id }, o.model ?? t.model);
    print({
      suggestion,
      draft: rule,
      notice: 'Draft only; no replayed tool side effects and no proven counterfactual.',
    });
  });
cli.command('label <eventId> <label>').action((id, label) => {
  if (!['correct', 'incorrect', 'override'].includes(label))
    throw new Error('Label must be correct, incorrect, or override');
  const e = store()
    .events()
    .find((e) => e.id === id && e.outcome === 'fire');
  if (!e) throw new Error('Unknown fire event');
  store().append({ type: 'label', target_id: id, rule_id: e.rule_id, label });
  console.log('Label saved.');
});
cli
  .command('digest')
  .option('--days <n>', 'window', '7')
  .option(
    '--webhook-env <variable>',
    'explicitly deliver to the Slack webhook URL in this environment variable',
  )
  .action(async (o) => {
    const text = digest(store().read(), store().events(), Number(o.days));
    console.log(text);
    if (o.webhookEnv) {
      const url = process.env[o.webhookEnv];
      if (!url) throw new Error('Webhook environment variable is not set');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
    }
  });
cli
  .command('budget')
  .option('--days <n>', 'window', '30')
  .action((o) => {
    const breaches = budgetBreaches(store().read(), store().events(), Number(o.days));
    print(breaches);
    if (breaches.length) process.exitCode = 2;
  });
cli
  .command('lifecycle')
  .option('--model <id>')
  .option('--apply')
  .action((o) => {
    const changes = lifecycle(store().read(), store().events(), o.model);
    if (o.apply)
      store().update((v) => {
        for (const c of changes) v.rules.find((r) => r.id === c.id)!.status = c.status;
        return v;
      });
    print({ applied: !!o.apply, changes });
  });
cli
  .command('upgrade <model>')
  .description('Report rules automatically shadowed by a model upgrade')
  .action((model) => {
    print({
      model,
      changes: lifecycle(store().read(), store().events(), model),
      proposed_new_rules: propose(
        store()
          .traces()
          .filter((t) => t.model === model),
      ),
      note: 'Reactivation requires explicit human review of fresh evidence.',
    });
  });
cli
  .command('evaluate')
  .description('Evaluate one Context JSON from stdin; errors fail open')
  .action(async () => {
    try {
      const ctx = contextSchema.parse(JSON.parse(readFileSync(0, 'utf8')));
      print(await new Runtime(store()).evaluate(ctx));
    } catch (e) {
      print({ blocked: false, masked_tools: [], evaluations: [], error: String(e) });
    }
  });
cli
  .command('golden <id>')
  .requiredOption('--output <file>')
  .option('--format <format>', 'json or vitest', 'json')
  .action((id, o) => {
    const r = store()
      .read()
      .rules.find((r) => r.id === id);
    if (!r) throw new Error('Unknown rule');
    if (r.condition.type !== 'code')
      throw new Error('Offline golden cases require a code condition');
    const phase = r.actions.some((a) => ['block', 'human'].includes(a.type))
      ? ('tool' as const)
      : ('model' as const);
    const cases = store()
      .traces()
      .flatMap((t) =>
        t.tools.map((_, i) => {
          const context = {
            session_id: t.id,
            step: phase === 'tool' ? i : i + 1,
            model: t.model,
            intent: t.intent ?? '',
            phase,
            tools: [...new Set(t.tools.map((x) => x.tool))],
            trajectory: t.tools.slice(0, phase === 'tool' ? i : i + 1),
            ...(phase === 'tool' ? { proposed: t.tools[i] } : {}),
          };
          return {
            trace_id: t.id,
            context,
            expected_match: new Engine({
              version: 1,
              rules: [{ ...r, status: 'shadow' }],
            }).evaluate(context).evaluations[0]?.matched,
          };
        }),
      )
      .filter((c) => c.expected_match !== null && c.expected_match !== undefined);
    const positives = cases.filter((c) => c.expected_match).slice(0, 10),
      negatives = cases.filter((c) => !c.expected_match).slice(0, 10);
    if (!positives.length)
      throw new Error(
        'No matching historical situation; import a positive example before exporting a regression test',
      );
    cases.splice(0, cases.length, ...positives, ...negatives);
    const fixture = {
      format: 'mirrors-golden-v1',
      rule: { ...r, status: 'shadow' },
      cases,
      notice: 'Condition regression cases; these do not prove intervention effectiveness.',
    };
    let out = JSON.stringify(fixture, null, 2);
    if (o.format === 'vitest')
      out = `import { test, expect } from 'vitest';\nimport { Engine } from '@ai-singhal/mirrors';\nconst fixture = ${out};\ntest('rule matches historical situations', () => { for (const c of fixture.cases) expect(new Engine({version:1,rules:[fixture.rule]}).evaluate(c.context as any).evaluations[0]?.matched).toBe(c.expected_match); });\n`;
    else if (o.format !== 'json') throw new Error('Unknown format');
    writeFileSync(resolve(cli.opts().cwd, o.output), out);
    console.log(`Exported ${cases.length} cases.`);
  });
cli
  .command('install <pack>')
  .description('Install a bundled pack in shadow; no remote code execution')
  .action((pack) => {
    if (/@/.test(pack) && !pack.endsWith('@1'))
      throw new Error('Only bundled pack version @1 is available');
    const id = pack.replace(/@\d+$/, '');
    const rules = starterLedger().rules.filter(
      (r) => r.id === id || r.source.ref?.split('@')[0] === id,
    );
    if (!rules.length)
      throw new Error(
        'Bundled packs: loop-breaker@1, document-edits@1, tool-readiness@1, completion-evidence@1',
      );
    console.log(`Installed ${addRules(rules)} shadow rules.`);
  });
cli
  .command('gate')
  .description('Flag new conditional instructions in prompt files')
  .option('--base <ref>', 'git base ref', 'HEAD')
  .option('--diff <file>', 'read an existing unified diff')
  .action((o) => {
    const diff = o.diff
      ? readFileSync(resolve(cli.opts().cwd, o.diff), 'utf8')
      : execFileSync('git', ['diff', o.base, '--'], { cwd: cli.opts().cwd, encoding: 'utf8' });
    let file = '',
      line = 0;
    const findings: any[] = [];
    for (const s of diff.split('\n')) {
      if (s.startsWith('+++ b/')) file = s.slice(6);
      const h = s.match(/^@@ .*\+(\d+)/);
      if (h) line = Number(h[1]) - 1;
      else if (s.startsWith('+') && !s.startsWith('+++')) {
        line++;
        if (
          /(?:AGENTS|CLAUDE)\.md$|prompt.*\.(?:md|txt|yaml)$/i.test(file) &&
          /\b(if|when|unless|before|after|always|never|must)\b/i.test(s) &&
          !s.includes('mirrors-ignore:')
        )
          findings.push({
            file,
            line,
            instruction: s.slice(1),
            suggestion: 'Move this behavioral condition into a shadow rule with mirrors add.',
          });
      } else if (s.startsWith(' ')) line++;
    }
    print({ findings });
    if (findings.length) process.exitCode = 1;
  });
cli
  .command('serve')
  .option('--judge', 'enable the configured remote judgment model')
  .option('--port <port>', 'loopback port', '7433')
  .action(async (o) => {
    store().read();
    const judge = o.judge ? (await import('./judge.js')).createJudge() : undefined;
    const server = startServer(store(), Number(o.port), '127.0.0.1', judge);
    server.on('listening', () =>
      console.log(
        `Mirrors ledger: http://127.0.0.1:${(server.address() as any).port}\n${store().path}`,
      ),
    );
  });
cli
  .command('proxy')
  .option('--judge', 'enable remote judgment conditions')
  .requiredOption('--upstream <url>', 'OpenAI-compatible base URL, ending in /v1')
  .option('--port <port>', 'loopback port', '7434')
  .action(async (o) => {
    const judge = o.judge ? (await import('./judge.js')).createJudge() : undefined;
    startProxy(new Runtime(store(), judge), o.upstream, Number(o.port));
    console.log(
      `Proxy: http://127.0.0.1:${o.port}/v1 — send x-mirrors-session for stable cohorts.`,
    );
  });
cli
  .command('demo')
  .option('--dir <directory>', 'new directory for synthetic examples')
  .action((o) => {
    const dir = o.dir ? resolve(o.dir) : mkdtempSync(join(tmpdir(), 'mirrors-demo-'));
    createDemo(new Store(dir));
    console.log(`Synthetic demo created at ${dir}\nmirrors --cwd ${JSON.stringify(dir)} serve`);
  });
cli.parseAsync().catch((e) => {
  console.error(`mirrors: ${e.message ?? e}`);
  process.exitCode = 1;
});
