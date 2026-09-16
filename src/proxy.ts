import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Runtime } from './runtime.js';
import { normalizeExport } from './discover.js';
import { appendTail } from './engine.js';
export function startProxy(runtime: Runtime, upstream: string, port = 7434) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Upstream must be HTTP(S)');
  const server = createServer(async (req, res) => {
    try {
      if (
        req.method !== 'POST' ||
        !['/v1/chat/completions', '/chat/completions'].includes(req.url ?? '')
      ) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers.origin) {
        res.writeHead(403);
        res.end('Proxy is for SDK clients');
        return;
      }
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 5_000_000) throw new Error('Payload exceeds 5 MB');
      }
      const original = JSON.parse(text);
      const session = req.headers['x-mirrors-session'];
      let payload = original;
      // Without a stable caller-supplied session ID we cannot safely assign cohorts.
      if (typeof session === 'string') {
        try {
          const trajectory =
            normalizeExport({ id: session, messages: original.messages })[0]?.tools ?? [];
          const d = await runtime.evaluate({
            session_id: session,
            step: trajectory.length,
            model: original.model ?? 'unknown',
            intent: '',
            phase: 'model',
            capabilities: ['inject', 'mask_tools', 'force_tool', 'swap_model'],
            trajectory: trajectory.slice(-1000),
            tools: (original.tools ?? []).map((t: any) => t.function?.name).filter(Boolean),
          });
          payload = { ...original, messages: appendTail(original.messages, d) };
          if (d.masked_tools.length)
            payload.tools = (original.tools ?? []).filter(
              (t: any) => !d.masked_tools.includes(t.function?.name),
            );
          if (d.masked_tools.includes(original.tool_choice?.function?.name))
            payload.tool_choice = 'auto';
          if (d.forced_tool)
            payload.tool_choice = { type: 'function', function: { name: d.forced_tool } };
          if (d.model) payload.model = d.model;
        } catch {
          payload = original;
        }
      }
      const url = new URL(target);
      url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (req.headers.authorization) headers.authorization = req.headers.authorization;
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000),
      });
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      if (response.body) await pipeline(Readable.fromWeb(response.body as any), res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}
