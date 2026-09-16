import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ObservationStore } from './database.js';
import { readExports } from './normalize.js';
import { ingestRuns, importPromptFixes, registerFix } from './service.js';
import {
  signalSummary,
  releaseHealth,
  fixResults,
  verifyFix,
  observationDigest,
} from './health.js';
import { clusterIntents, nameIntent } from './intents.js';
import { hash } from '../engine.js';
import { Store } from '../store.js';
import { draftRule } from '../discover.js';
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
export function registerObservationCLI(cli: Command) {
  const open = () => new ObservationStore(cli.opts().cwd);
  const dbAction =
    (fn: (db: ObservationStore, ...args: any[]) => unknown) =>
    async (...args: any[]) => {
      const db = open();
      try {
        await fn(db, ...args);
      } finally {
        db.close();
      }
    };
  cli
    .command('ingest <path>')
    .description('Measure existing JSON/JSONL exports with no runtime hook')
    .option('--version <id>')
    .option('--model <id>')
    .option('--intent <name>')
    .option('--segment <name>')
    .option('--prompt-hash <hash>')
    .option('--code-ref <ref>')
    .action(
      dbAction((db, path, o) => {
        const result = readExports(resolve(cli.opts().cwd, path), {
          ...o,
          promptHash: o.promptHash,
          codeRef: o.codeRef,
        });
        const out = ingestRuns(db, result.runs);
        print({ ...out, warnings: [...result.warnings, ...out.warnings] });
        if (!out.imported) process.exitCode = 1;
      }),
    );
  cli
    .command('documentdb')
    .description('Read existing conversation documents; uses read-only credentials')
    .requiredOption('--uri-env <name>')
    .requiredOption('--database <name>')
    .requiredOption('--collection <name>')
    .option('--ca-file <path>')
    .option('--query <json>', 'MongoDB filter', '{}')
    .option('--limit <n>', 'maximum documents', '10000')
    .option('--version <id>')
    .option('--model <id>')
    .option('--intent <name>')
    .option('--segment <name>')
    .action(
      dbAction(async (db, o) => {
        const { ingestDocumentDB } = await import('./documentdb.js');
        print(
          await ingestDocumentDB(db, { ...o, limit: Number(o.limit), query: JSON.parse(o.query) }),
        );
        clusterIntents(db);
      }),
    );
  const signals = cli
    .command('signals')
    .description('Deterministic definitions and mandatory human samples');
  signals
    .command('list')
    .option('--days <n>', 'window', '30')
    .action(dbAction((db, o) => print(signalSummary(db, Number(o.days)))));
  signals
    .command('add <id>')
    .requiredOption('--name <text>')
    .requiredOption('--definition <text>')
    .option('--detector <id>', 'existing deterministic detector')
    .option('--judgment', 'opt-in judgment signal')
    .option('--confidence <n>', 'minimum confidence', '0.9')
    .option('--budget <n>', 'tool call budget', '25')
    .action(
      dbAction((db, id, o) => {
        if (!o.judgment && !db.signals().some((s) => s.detector === o.detector))
          throw Error('Choose an existing --detector or --judgment');
        db.saveSignal({
          id,
          name: o.name,
          definition_text: o.definition,
          kind: o.judgment ? 'judgment' : 'code',
          threshold: Number(o.confidence),
          detector: o.judgment ? 'judgment' : o.detector,
          config: { max_calls: Number(o.budget) },
          labeled_sample_path: null,
        });
        print({ added: id });
      }),
    );
  signals
    .command('score')
    .description('Rescore indexed runs; code only by default')
    .option('--judge', 'explicitly send runs to remote judgment adapter')
    .action(
      dbAction(async (db, o) => {
        const { detect } = await import('./signals.js');
        const judge = o.judge ? await import('./model.js') : null;
        for (const row of db.runs(1_000_000) as any[]) {
          const run = db.run(row.id);
          for (const s of db.signals().filter((s) => s.kind === 'code'))
            db.score(s.id, run.id, detect(s, run));
          if (judge) {
            for (const r of await judge.judgeSignals(
              run,
              db.signals().filter((s) => s.kind === 'judgment'),
              judge.haikuSignalJudge(),
            ))
              db.score(r.signal_id, run.id, r.result);
          }
        }
        print({ scored: true, remote_judgment: !!judge });
      }),
    );
  signals
    .command('label <signal> <run>')
    .requiredOption('--step <n>', '-1 for a run-level negative')
    .requiredOption('--agree <yes|no>')
    .option('--by <name>', 'reviewer', 'local')
    .action(
      dbAction((db, s, r, o) => {
        if (!['yes', 'no'].includes(o.agree)) throw Error('Use yes or no');
        print(db.label(s, r, Number(o.step), o.agree === 'yes', o.by));
      }),
    );
  signals.command('samples <signal>').action(
    dbAction((db, id) => {
      print({
        positive: db.db.prepare('SELECT * FROM signal_hits WHERE signal_id=? LIMIT 10').all(id),
        negative: db.db
          .prepare(
            'SELECT run_id FROM signal_results WHERE signal_id=? AND assessable=1 AND hit=0 LIMIT 10',
          )
          .all(id),
      });
    }),
  );
  cli
    .command('health')
    .option('--baseline <id>')
    .option('--version <id>')
    .option('--days <n>', 'rolling window', '30')
    .option('--min-runs <n>', 'per intent/segment/version', '30')
    .option('--delta <n>', 'absolute rate increase threshold', '0.05')
    .option('--intent <name>')
    .option('--segment <name>')
    .action(
      dbAction((db, o) =>
        print(
          releaseHealth(db, {
            ...o,
            days: Number(o.days),
            minRuns: Number(o.minRuns),
            delta: Number(o.delta),
          }),
        ),
      ),
    );
  const versions = cli.command('versions');
  versions.command('list').action(dbAction((db) => print(db.versions())));
  versions
    .command('add <id>')
    .requiredOption('--model <id>')
    .option('--prompt-hash <hash>')
    .option('--code-ref <ref>')
    .option('--deployed-at <iso>')
    .action(
      dbAction((db, id, o) => {
        const date = new Date(o.deployedAt ?? Date.now());
        if (!Number.isFinite(date.getTime())) throw Error('Invalid deployment timestamp');
        db.db
          .prepare('INSERT INTO versions VALUES(?,?,?,?,?,1)')
          .run(id, o.promptHash ?? null, o.codeRef ?? null, o.model, date.toISOString());
        db.audit('version-created', { id });
        print({ id });
      }),
    );
  const fixes = cli
    .command('fix')
    .description('Track a prompt, code, or optional runtime-rule fix');
  fixes
    .command('add <name>')
    .requiredOption('--signal <id>')
    .requiredOption('--type <prompt|code|rule>')
    .option('--id <id>')
    .option('--version <id>')
    .option('--baseline <id>')
    .option('--model <id>')
    .option('--notes <text>', 'context', '')
    .option('--source <ref>', 'commit/PR/file', 'manual')
    .action(
      dbAction((db, name, o) => {
        const id = o.id ?? 'fix-' + hash(name + randomUUID()).slice(0, 10);
        const f = registerFix(db, {
          id,
          name,
          target_signal_id: o.signal,
          type: o.type,
          version_id: o.version ?? null,
          baseline_version: o.baseline ?? null,
          model: o.model ?? null,
          notes: o.notes,
          source: o.source,
        });
        print(f);
      }),
    );
  fixes.command('list').action(dbAction((db) => print(db.fixes())));
  fixes
    .command('ship <id>')
    .requiredOption('--version <id>')
    .option('--baseline <id>')
    .option('--model <id>')
    .action(
      dbAction((db, id, o) => {
        print(
          db.updateFix(id, {
            status: 'shipped',
            version_id: o.version,
            baseline_version: o.baseline ?? null,
            model: o.model ?? null,
          }),
        );
      }),
    );
  fixes
    .command('results <id>')
    .option('--days <n>', 'window', '30')
    .action(dbAction((db, id, o) => print(fixResults(db, id, { days: Number(o.days) }))));
  fixes
    .command('verify <id>')
    .option('--days <n>', 'window', '30')
    .option('--min-runs <n>', 'each segment/arm', '30')
    .action(
      dbAction((db, id, o) =>
        print(verifyFix(db, id, { days: Number(o.days), minRuns: Number(o.minRuns) })),
      ),
    );
  fixes
    .command('retire <id>')
    .action(dbAction((db, id) => print(db.updateFix(id, { status: 'retired' }))));
  fixes
    .command('import-prompt <file>')
    .requiredOption('--signal <id>', 'hypothesized target; review each draft')
    .action(
      dbAction((db, file, o) =>
        print(
          importPromptFixes(
            db,
            readFileSync(resolve(cli.opts().cwd, file), 'utf8'),
            file,
            o.signal,
          ),
        ),
      ),
    );
  const intents = cli.command('intents');
  intents
    .command('cluster')
    .option('--threshold <n>', 'local cosine threshold', '0.55')
    .action(dbAction((db, o) => print(clusterIntents(db, Number(o.threshold)))));
  intents.command('name <id> <name>').action(
    dbAction((db, id, name) => {
      nameIntent(db, id, name);
      print({ id, name });
    }),
  );
  cli.command('inspect <run>').action(dbAction((db, id) => print(db.run(id))));
  cli
    .command('digest')
    .alias('release-digest')
    .option('--days <n>', 'window', '7')
    .option('--webhook-env <name>', 'explicit Slack delivery')
    .action(
      dbAction(async (db, o) => {
        const text = observationDigest(db, { days: Number(o.days) });
        console.log(text);
        if (o.webhookEnv) {
          const url = process.env[o.webhookEnv];
          if (!url) throw Error('Webhook environment variable is missing');
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) throw Error(`Webhook returned ${r.status}`);
        }
      }),
    );
  cli
    .command('replay <signal>')
    .description('Opt-in model calls with cached tools; never executes tools')
    .requiredOption('--model <id>')
    .option('--prompt <file>', 'candidate system prompt')
    .option('--tools <file>', 'recorded JSON tool definitions')
    .option('--limit <n>', 'affected runs', '100')
    .option('--concurrency <n>', 'parallel runs, max 8', '4')
    .option('--output <file>')
    .action(
      dbAction(async (db, id, o) => {
        const { replayAffected } = await import('./replay.js');
        const { providerReplay } = await import('./model.js');
        const report = await replayAffected(db, id, providerReplay, {
          model: o.model,
          system: o.prompt ? readFileSync(resolve(cli.opts().cwd, o.prompt), 'utf8') : undefined,
          tools: o.tools
            ? JSON.parse(readFileSync(resolve(cli.opts().cwd, o.tools), 'utf8'))
            : undefined,
          limit: Number(o.limit),
          concurrency: Number(o.concurrency),
        });
        if (o.output)
          writeFileSync(resolve(cli.opts().cwd, o.output), JSON.stringify(report, null, 2));
        else print(report);
      }),
    );
  cli
    .command('watch <path>')
    .description('Poll local exports and report changed release regressions')
    .option('--interval <seconds>', 'poll interval (minimum 10)', '60')
    .option('--version <id>')
    .option('--webhook-env <name>', 'explicit Slack alerts')
    .action(async (path, o) => {
      const db = open();
      let stopped = false,
        last = '';
      const stop = () => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        while (!stopped) {
          const data = readExports(resolve(cli.opts().cwd, path), { version: o.version });
          ingestRuns(db, data.runs);
          const h = releaseHealth(db);
          const regressions = h.rows.filter((r) => r.verdict === 'regression');
          const signature = hash(regressions);
          if (signature !== last && regressions.length) {
            print({ event: 'release-regression', ...h });
            if (o.webhookEnv) {
              const url = process.env[o.webhookEnv];
              if (!url) throw Error('Webhook environment variable missing');
              await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text: observationDigest(db) }),
                signal: AbortSignal.timeout(10000),
              });
            }
          }
          last = signature;
          const until = Date.now() + Math.max(10, Number(o.interval)) * 1000;
          while (!stopped && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        db.close();
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
}
