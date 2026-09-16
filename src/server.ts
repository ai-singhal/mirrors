import { ObservationStore } from './observe/database.js';
import { observationApi } from './observe/api.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import {
  flaggedProposals,
  flagFailure,
  reviewQueue,
  resolveReview,
  promptSavings,
} from './workflows.js';
import { Store } from './store.js';
import type { Judge } from './engine.js';
import { Runtime } from './runtime.js';
import { ruleSchema, contextSchema, ledgerSchema } from './schema.js';
import { metrics, budgetBreaches, digest, lifecycle } from './metrics.js';
import { draftRule, importPrompt, normalizeExport, backtest, propose } from './discover.js';
const bodySchema = z.object({ text: z.string().min(1).max(1000000) });
async function body(req: IncomingMessage) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 5_000_000) throw new Error('Request exceeds 5 MB');
  }
  return raw ? JSON.parse(raw) : {};
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}
export function startServer(store: Store, port = 7433, host = '127.0.0.1', judge?: Judge) {
  const runtime = new Runtime(store, judge);
  const observations = new ObservationStore(store.root);
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../ui-dist'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../ui-dist'),
  ];
  const uiRoot = candidates.find(existsSync) ?? candidates[0];
  const server = createServer(async (req, res) => {
    try {
      const actualPort = (server.address() as any)?.port ?? port;
      const allowed = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      if (!allowed.has(req.headers.host ?? ''))
        return json(res, 403, { error: 'Invalid local host' });
      if (req.headers.origin && !allowed.has(new URL(req.headers.origin).host))
        return json(res, 403, { error: 'Cross-origin request rejected' });
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (
        path.startsWith('/api/') &&
        req.method !== 'GET' &&
        !req.headers['content-type']?.startsWith('application/json')
      )
        return json(res, 415, { error: 'Use application/json' });
      if (path.startsWith('/api/observe/')) {
        const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
        return json(
          res,
          200,
          await observationApi(
            observations,
            req.method ?? 'GET',
            path.slice('/api/observe'.length),
            parsedUrl.searchParams,
            req.method === 'GET' ? undefined : await body(req),
          ),
        );
      }
      if (path === '/api/health') return json(res, 200, { ok: true });
      if (path === '/api/state' && req.method === 'GET') {
        const ledger = store.read();
        const events = store.events();
        return json(res, 200, {
          ledger,
          revision: store.revision(),
          metrics: metrics(ledger, events),
          queue: reviewQueue(events),
          prompt_savings: promptSavings(events),
          events: events
            .filter(
              (e) =>
                (e.type === 'evaluation' && e.matched) || e.type === 'audit' || e.type === 'label',
            )
            .slice(-100)
            .reverse(),
          budgets: budgetBreaches(ledger, events),
          digest: digest(ledger, events),
          backtest: backtest(ledger, store.traces()),
          traces: store.traces().length,
          synthetic: store.synthetic(),
          yaml: readFileSync(store.path, 'utf8'),
        });
      }
      if (path === '/api/rules' && req.method === 'POST') {
        const b = bodySchema.parse(await body(req));
        const r = draftRule(b.text);
        store.update((v) => {
          if (v.rules.some((x) => x.id === r.id)) throw new Error('Rule already exists');
          v.rules.push(r);
          return v;
        });
        runtime.reload();
        return json(res, 201, r);
      }
      const ruleMatch = path.match(/^\/api\/rules\/([a-z0-9_-]+)$/);
      if (ruleMatch && req.method === 'PATCH') {
        const b = z
          .object({
            revision: z.string(),
            patch: ruleSchema.partial().omit({ id: true, created_at: true }),
          })
          .strict()
          .parse(await body(req));
        store.update(
          (v) => {
            const index = v.rules.findIndex((r) => r.id === ruleMatch[1]);
            if (index < 0) throw new Error('Unknown rule');
            v.rules[index] = ruleSchema.parse({ ...v.rules[index], ...b.patch });
            return v;
          },
          b.revision,
          'local-ui',
        );
        runtime.reload();
        return json(res, 200, { ok: true });
      }
      if (path === '/api/yaml' && req.method === 'PUT') {
        const b = z
          .object({ yaml: z.string().max(1000000), revision: z.string() })
          .parse(await body(req));
        const v = ledgerSchema.parse(parseDocument(b.yaml).toJS({ maxAliasCount: 0 }));
        store.update(() => v, b.revision, 'yaml-editor');
        runtime.reload();
        return json(res, 200, { ok: true });
      }
      if (path === '/api/import/prompt' && req.method === 'POST') {
        const b = bodySchema.parse(await body(req));
        const candidates = importPrompt(b.text, 'local-ui');
        let added = 0;
        store.update((v) => {
          for (const r of candidates)
            if (!v.rules.some((x) => x.id === r.id)) {
              v.rules.push(r);
              added++;
            }
          return v;
        });
        runtime.reload();
        return json(res, 200, { added });
      }
      if (path === '/api/import/traces' && req.method === 'POST') {
        const b = await body(req);
        const traces = normalizeExport(b);
        if (!traces.length)
          throw new Error(
            'No supported tool events found. Import JSON/JSONL with messages, tools, or spans.',
          );
        store.saveTraces(traces);
        return json(res, 200, { imported: traces.length });
      }
      if (path === '/api/proposals' && req.method === 'GET')
        return json(res, 200, flaggedProposals(store));
      if (path === '/api/flags' && req.method === 'POST') {
        const b = z
          .object({ trace_id: z.string(), note: z.string().max(4000) })
          .parse(await body(req));
        return json(res, 201, flagFailure(store, b.trace_id, b.note));
      }
      if (path === '/api/reviews' && req.method === 'POST') {
        const b = z
          .object({ target_id: z.string(), decision: z.enum(['approved', 'denied']) })
          .parse(await body(req));
        return json(res, 200, resolveReview(store, b.target_id, b.decision));
      }
      if (path === '/api/labels' && req.method === 'POST') {
        const b = z
          .object({ target_id: z.string(), label: z.enum(['correct', 'incorrect', 'override']) })
          .parse(await body(req));
        const target = store
          .events()
          .find((e) => e.id === b.target_id && e.type === 'evaluation' && e.outcome === 'fire');
        if (!target) throw new Error('Label an actual intervention event');
        store.append({ type: 'label', ...b, rule_id: target.rule_id });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/evaluate' && req.method === 'POST') {
        runtime.reload();
        return json(res, 200, await runtime.evaluate(contextSchema.parse(await body(req))));
      }
      if (path === '/api/finish' && req.method === 'POST') {
        const b = z
          .object({
            context: contextSchema,
            failures: z.record(z.string(), z.boolean()).optional(),
          })
          .parse(await body(req));
        runtime.finish(b.context, b.failures);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/lifecycle' && req.method === 'POST') {
        const b = z
          .object({ model: z.string().optional(), apply: z.boolean().default(false) })
          .parse(await body(req));
        const changes = lifecycle(store.read(), store.events(), b.model);
        if (b.apply)
          store.update((v) => {
            for (const c of changes) v.rules.find((r) => r.id === c.id)!.status = c.status;
            return v;
          });
        runtime.reload();
        return json(res, 200, { changes });
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const file = resolve(uiRoot, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(uiRoot + '/')) return json(res, 403, { error: 'Invalid path' });
      if (!existsSync(file)) return json(res, 404, { error: 'UI not built. Run npm run build.' });
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      res.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'content-security-policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      });
      res.end(readFileSync(file));
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.once('close', () => observations.close());
  server.listen(port, host);
  return server;
}
