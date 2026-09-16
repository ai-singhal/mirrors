# Optional runtime integrations

Measurement uses `mirrors ingest` and does not require these wrappers. Add runtime hooks only when a rule-type fix needs an intervention.

Install from this source checkout, build, and link the CLI. In another Node project, use `npm install /absolute/path/to/mirrors`. No registry package is assumed. Python bridges need the loopback server running: `mirrors --cwd /path/to/agent serve`.

## TypeScript core

```ts
import { Runtime, Store, appendTail } from '@ai-singhal/mirrors';

const runtime = new Runtime(new Store('/path/to/agent'));
const context = {
  session_id: 'unique-run-42',
  model: 'provider/model-version',
  step: 2,
  phase: 'model' as const,
  intent: 'Edit a document',
  tools: ['read', 'write'],
  capabilities: ['inject' as const],
  trajectory: [
    { tool: 'write', args: { id: 'x' }, status: 'error' as const },
    { tool: 'write', args: { id: 'x' }, status: 'error' as const },
  ],
};
const decision = await runtime.evaluate(context);
const nextMessages = appendTail(messages, decision);
// Give nextMessages to your model. Preserve the original system and history.
// At terminal completion, pass the final trajectory and supported capabilities.
runtime.finish({ ...context, trajectory: finalToolEvents });
```

Declare only capabilities that your host applies. A `tool` phase context additionally includes `proposed: {tool, args, status: 'unknown'}`. Inspect `blocked` before executing. Use `explain(decision)` for plain-English one-line records.

## AI SDK 7

```ts
import { generateText, stepCountIs, gateway } from 'ai';
import { Runtime, Store } from '@ai-singhal/mirrors';
import { createAIAdapter } from '@ai-singhal/mirrors/ai-sdk';

const adapter = createAIAdapter(new Runtime(new Store(process.cwd())), {
  sessionId: crypto.randomUUID(),
  modelId: 'anthropic/claude-haiku-4.5',
  tools: Object.keys(tools),
  resolveModel: (id) => gateway(id), // optional; enables model swaps
});
const result = await generateText({
  model: gateway('anthropic/claude-haiku-4.5'),
  tools: adapter.wrapTools(tools),
  prepareStep: adapter.prepareStep,
  stopWhen: stepCountIs(8),
  prompt: 'Your task',
});
adapter.finish(result);
```

Use one adapter per run and both `prepareStep` and `wrapTools`. The wrapper blocks before invoking a tool's `execute`. A human decision raises `MirrorsBlockedError`; your agent may report it as a tool error, so the host must implement any pause/resume policy. Tools delegated to external execution need a corresponding external guard. Streaming users call `finish` with final steps when the stream completes.

The adapter leaves the SDK's message prefix untouched and supplies changes through its [prepareStep interface](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling). A model resolver should return a supported model or throw. If resolution fails the original model remains, although an engine selection decision may already be logged.

## OpenClaw

The package includes `openclaw.plugin.json` and the built plugin export. Install the source package using your OpenClaw version's local plugin installer, then configure the `mirrors` entry:

```json
{
  "plugins": {
    "entries": {
      "mirrors": {
        "enabled": true,
        "config": { "directory": "/absolute/path/to/agent", "model": "actual-model-id" },
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

The hook adapter registers `before_prompt_build`, `before_tool_call`, `after_tool_call`, and `agent_end`. Prompt context is appended via `appendContext`; tool blocking returns `block`/`blockReason`. Model IDs from the hook take precedence over the configured fallback. It does not implement unsupported tool-mask/model-route hooks. Prompt hooks are turn-scoped on some harnesses and may not run before every model call.

Validate hook availability in your installed OpenClaw build. See [typed hooks](https://docs.openclaw.ai/plugins/hooks), [prompt hooks](https://docs.openclaw.ai/plugins/hooks/prompt-and-session), and [tool policy](https://docs.openclaw.ai/plugins/hooks/tool-policy). Tests verify the adapter contract with hook fixtures, not a complete OpenClaw installation.

## Python setup

```sh
python3 -m venv .venv
.venv/bin/pip install -e '/absolute/path/to/mirrors/python[pydantic,langgraph]'
```

`MirrorsClient` uses standard-library HTTP. Instantiate per run with a stable session ID and actual model ID. It fails open on transport/validation errors. The default timeout is 250ms; opt-in remote judgments often need a larger caller timeout (for example `timeout=1.0` for a 300ms judgment budget).

### Hermes

In a Hermes plugin module:

```python
from mirrors.hermes import register
# Hermes calls register(ctx); the plugin registers its four hooks.
```

The client connects to `http://127.0.0.1:7433`. For another local address, instantiate `HermesPlugin(url=...)` and call `.register(ctx)`. Hooks are `pre_llm_call`, `pre_tool_call`, `post_tool_call`, and `post_llm_call`. `pre_llm_call` appends turn context through the host hook; it does not run for every provider attempt. Completed turns call `finish`; interrupted turns without the terminal hook have no outcome and therefore do not inflate the denominator. Require real session IDs; missing IDs leave the host untouched.

See the [Hermes hook contract](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks). This bridge is tested against contract fixtures, not a full Hermes installation.

### Pydantic AI 2.43+

```python
from uuid import uuid4
from pydantic_ai import Agent
from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.toolsets import FunctionToolset
from mirrors import MirrorsClient
from mirrors.pydantic_ai import MirrorsToolset, history_processor

client = MirrorsClient(str(uuid4()), 'your-actual-model-id')
toolset = MirrorsToolset(FunctionToolset(tools=[your_tool]), client)
agent = Agent(
    'your-provider:your-model',
    toolsets=[toolset],
    capabilities=[ProcessHistory(history_processor(client))],
)
result = agent.run_sync('Your task')
client.finish()
```

The toolset filters available tools and checks each call before execution. `ProcessHistory` appends a fresh tail request. A blocked tool raises `ModelRetry`. Test coverage executes this with Pydantic AI's real `TestModel`; no paid provider call is required. Older Pydantic AI versions used a different history-processor registration interface and are not supported by this example.

### LangGraph

```python
from mirrors import MirrorsClient
from mirrors.langgraph import LangGraphAdapter

adapter = LangGraphAdapter(MirrorsClient('unique-run-id', 'actual-model-id'))

async def model_node(state):
    prepared = await adapter.prepare(state['messages'], list(tools))
    allowed = [tools[name] for name in prepared['allowed_tools']]
    bound = model.bind_tools(allowed)
    if prepared['forced_tool']:
        bound = model.bind_tools(allowed, tool_choice=prepared['forced_tool'])
    reply = await bound.ainvoke(prepared['messages'])
    return {'messages': [reply]}

# Inside the tool node, before side effects:
result = await adapter.call(tool_name, args, tools[tool_name].ainvoke)
# At terminal completion:
adapter.client.finish()
```

Wire these helpers into your graph's own state reducer and tool message format. Do not add the prepared tail to persistent history unless you intentionally want it persisted. Pass `can_swap_model=True` only when your node applies the returned `model` selection. Concurrent graph branches need separate clients/contexts or host serialization. Tests execute a small real `StateGraph` and verify a block prevents the tool function from running.

## Generic HTTP proxy

```sh
mirrors proxy --upstream https://api.openai.com/v1
```

Point an OpenAI-compatible client at `http://127.0.0.1:7434/v1`, retain its upstream API key, and send `x-mirrors-session: UNIQUE_RUN_ID` on every request. Requests without this stable ID pass through without intervention. The proxy forwards authorization only to the configured upstream. It supports chat completions and streaming; it is not a Responses API proxy.

Model requests can append a tail, filter tool payload entries, choose a tool or model. Tool execution occurs outside the proxy: use a host guard or `/api/evaluate` in tool phase for blocking/human actions. Report terminal outcomes separately. The proxy never retries an upstream call on your behalf. Local proxy failures are not upstream retries.

## Loopback API

JSON request bodies are required for mutations. The server validates Host and Origin and binds only to loopback through the CLI. This is a single-user local API, not a shared authenticated service.

| Endpoint             | Method / body                                                          |
| -------------------- | ---------------------------------------------------------------------- |
| `/api/health`        | GET                                                                    |
| `/api/state`         | GET; ledger, revision, metrics, recent events, queue, prompt snapshots |
| `/api/rules`         | POST `{text}`; create a shadow draft                                   |
| `/api/rules/:id`     | PATCH `{revision, patch}`; optimistic concurrency                      |
| `/api/yaml`          | PUT `{revision, yaml}`; validated replacement                          |
| `/api/import/prompt` | POST `{text}`                                                          |
| `/api/import/traces` | POST native trace/export data                                          |
| `/api/proposals`     | GET; drafts from flagged traces                                        |
| `/api/flags`         | POST `{trace_id, note}`                                                |
| `/api/labels`        | POST `{target_id, label}`                                              |
| `/api/reviews`       | POST `{target_id, decision: "approved" \| "denied"}`                   |
| `/api/evaluate`      | POST Context; returns Decision                                         |
| `/api/finish`        | POST `{context, failures?: {rule_id: boolean}}`                        |
| `/api/lifecycle`     | POST `{model?, apply?: boolean}`                                       |

Use `/api/state` queue entries or `mirrors queue` to read a review decision. Approval is a record, not automatic execution. Your host controls if/how the operation resumes.

## Agent skill

Copy `skills/mirrors` into your project's `.agents/skills/` (Codex) or `.claude/skills/` (Claude Code). The packaged skill helps draft scoped fixes and preserve evidence. It does not install itself globally or activate rules automatically.
