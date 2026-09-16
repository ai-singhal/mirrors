import { it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Store } from '../src/store';
import { Runtime } from '../src/runtime';
import { starterLedger } from '../src/packs';
import { startServer } from '../src/server';
import { startProxy } from '../src/proxy';
import { createAIAdapter, MirrorsBlockedError } from '../src/adapters/ai-sdk';
import { registerOpenClaw } from '../src/adapters/openclaw';
import { contextSchema, ruleSchema } from '../src/schema';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
function setup() {
  const s = new Store(mkdtempSync(join(tmpdir(), 'mirrors-integration-')));
  s.init(starterLedger());
  return s;
}
async function listen(server: Server) {
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
const post = (url: string, data: unknown, method = 'POST') =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
it('edits persist through the HTTP interface with optimistic concurrency', async () => {
  const s = setup(),
    url = await listen(startServer(s, 0));
  const first = await (await fetch(url + '/api/state')).json();
  const res = await post(
    url + '/api/rules/loop-breaker',
    { revision: first.revision, patch: { status: 'active', rollout: 20 } },
    'PATCH',
  );
  expect(res.status).toBe(200);
  expect(s.read().rules[0].status).toBe('active');
  expect(
    (
      await post(
        url + '/api/rules/loop-breaker',
        { revision: first.revision, patch: { status: 'off' } },
        'PATCH',
      )
    ).status,
  ).toBe(400);
});
it('rejects cross-site mutations and form posts', async () => {
  const url = await listen(startServer(setup(), 0));
  expect(
    (
      await fetch(url + '/api/rules', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect((await fetch(url + '/api/rules', { method: 'POST', body: 'text=x' })).status).toBe(415);
});
it('imports prompt candidates and trace evidence via HTTP', async () => {
  const url = await listen(startServer(setup(), 0));
  const a = await (
    await post(url + '/api/import/prompt', { text: 'When a lookup fails, verify the source.' })
  ).json();
  expect(a.added).toBe(1);
  const b = await (
    await post(url + '/api/import/traces', {
      id: 'run',
      model: 'test',
      timestamp: new Date().toISOString(),
      tools: [{ tool: 'lookup', args: {}, status: 'error' }],
    })
  ).json();
  expect(b.imported).toBe(1);
});
it('runtime fails open after a telemetry write failure', async () => {
  const s = setup();
  s.update((v) => {
    v.rules[0].status = 'active';
    v.rules[0].rollout = 100;
    return v;
  });
  const runtime = new Runtime(s);
  s.logDecision = () => {
    throw new Error('disk full');
  };
  const d = await runtime.evaluate(
    contextSchema.parse({
      session_id: 'a',
      step: 2,
      model: 'm',
      trajectory: [
        { tool: 'x', args: {}, status: 'error' },
        { tool: 'x', args: {}, status: 'error' },
      ],
    }),
  );
  expect(d.injection).toBeUndefined();
  expect(d.error).toContain('disk full');
});
it('proxy preserves cached prefix and forwards streamed responses', async () => {
  let payload: any;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const b of req) raw += b;
    payload = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"ok":true}\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  const upstreamUrl = await listen(upstream);
  const s = setup();
  s.update((v) => {
    v.rules = [
      ruleSchema.parse({
        id: 'tail',
        name: 'Tail',
        condition: { type: 'code', when: { field: 'step', op: 'gte', value: 0 } },
        status: 'active',
        rollout: 100,
        actions: [{ type: 'inject', text: 'Specific reminder' }],
      }),
    ];
    return v;
  });
  const proxy = await listen(startProxy(new Runtime(s), upstreamUrl + '/v1', 0));
  const messages = [
    { role: 'system', content: 'Unchanged system' },
    { role: 'user', content: 'Hi' },
  ];
  const response = await fetch(proxy + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mirrors-session': 'abc' },
    body: JSON.stringify({ model: 'm', messages, stream: true }),
  });
  expect(await response.text()).toContain('[DONE]');
  expect(payload.messages.slice(0, 2)).toEqual(messages);
  expect(payload.messages[2].content).toContain('Specific reminder');
});
it('AI SDK tool wrapper prevents the actual tool side effect', async () => {
  const s = setup();
  s.update((v) => {
    v.rules = [
      ruleSchema.parse({
        id: 'block',
        name: 'Block',
        condition: { type: 'code', when: { field: 'proposed.tool', op: 'eq', value: 'write' } },
        status: 'active',
        rollout: 100,
        actions: [{ type: 'block', reason: 'Review first' }],
      }),
    ];
    return v;
  });
  const adapter = createAIAdapter(new Runtime(s), {
    sessionId: 'x',
    modelId: 'm',
    tools: ['write'],
  });
  let called = false;
  const wrapped = adapter.wrapTools({
    write: {
      inputSchema: {} as any,
      execute: async (_input: unknown, _options?: unknown) => {
        called = true;
        return 'done';
      },
    },
  });
  await expect(wrapped.write.execute!({}, {} as any)).rejects.toBeInstanceOf(MirrorsBlockedError);
  expect(called).toBe(false);
});
it('OpenClaw plugin maps typed hooks to blocking decisions', async () => {
  const s = setup();
  s.update((v) => {
    v.rules = [
      ruleSchema.parse({
        id: 'stop',
        name: 'Stop',
        condition: { type: 'code', when: { field: 'proposed.tool', op: 'eq', value: 'write' } },
        status: 'active',
        rollout: 100,
        actions: [{ type: 'block', reason: 'Check state' }],
      }),
    ];
    return v;
  });
  const hooks: Record<string, Function> = {};
  registerOpenClaw({
    pluginConfig: { directory: s.root },
    on: (name, fn) => {
      hooks[name] = fn;
    },
  });
  const result = await hooks.before_tool_call(
    { toolName: 'write', params: {} },
    { sessionKey: 's' },
  );
  expect(result.block).toBe(true);
  expect(result.blockReason).toContain('Check state');
});

it('runs the actual AI SDK loop with a tail intervention and unchanged system prompt', async () => {
  const { generateText } = await import('ai');
  const { MockLanguageModelV4 } = await import('ai/test');
  const model = new MockLanguageModelV4({
    modelId: 'test-model',
    doGenerate: {
      content: [{ type: 'text', text: 'Done' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const s = setup();
  s.update((v) => {
    v.rules = [
      ruleSchema.parse({
        id: 'tail',
        name: 'Tail',
        status: 'active',
        rollout: 100,
        condition: { type: 'code', when: { field: 'step', op: 'eq', value: 0 } },
        actions: [{ type: 'inject', text: 'Check the source' }],
      }),
    ];
    return v;
  });
  const adapter = createAIAdapter(new Runtime(s), {
    sessionId: 'sdk-run',
    modelId: 'test-model',
    tools: [],
  });
  const result = await generateText({
    model,
    system: 'Original system',
    prompt: 'Task',
    prepareStep: adapter.prepareStep,
  });
  expect(result.text).toBe('Done');
  expect(model.doGenerateCalls[0].prompt[0]).toEqual({
    role: 'system',
    content: 'Original system',
  });
  expect(JSON.stringify(model.doGenerateCalls[0].prompt.at(-1))).toContain('Check the source');
  adapter.finish(result);
});

it('proxy forwards the original request once when intervention preparation fails', async () => {
  let payload: any,
    calls = 0;
  const upstream = createServer(async (req, res) => {
    calls++;
    let raw = '';
    for await (const b of req) raw += b;
    payload = JSON.parse(raw);
    res.end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  const upstreamUrl = await listen(upstream);
  const runtime = new Runtime(setup());
  runtime.evaluate = async () => {
    throw Error('unexpected failure');
  };
  const proxy = await listen(startProxy(runtime, upstreamUrl + '/v1', 0));
  const original = { model: 'm', messages: [{ role: 'user', content: 'Hi' }] };
  expect(
    (
      await fetch(proxy + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'x-mirrors-session': 'run' },
        body: JSON.stringify(original),
      })
    ).status,
  ).toBe(200);
  expect(calls).toBe(1);
  expect(payload).toEqual(original);
});
