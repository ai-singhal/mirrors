# Trace import

```sh
mirrors import traces ./exports
```

Directories are traversed recursively for `.json`/`.jsonl`; hidden directories and `node_modules` are skipped. Malformed files are reported as warnings. Reimporting a trace with the same ID replaces its stored JSON. Export adapters are best-effort, not authenticated live vendor connectors.

The native format is the reliable interchange contract:

```json
{
  "id": "run-001",
  "model": "provider/model-version",
  "timestamp": "2026-09-16T12:00:00Z",
  "intent": "Update a document",
  "tools": [
    { "id": "call-1", "tool": "read_document", "args": { "id": "doc-1" }, "status": "success" },
    {
      "id": "call-2",
      "tool": "edit_document",
      "args": { "node": "n-1" },
      "status": "error",
      "error": "Unknown node"
    }
  ]
}
```

Tool statuses: `success`, `error`, `unknown`, `blocked`. Model, timestamp and stable session ID should be supplied for useful comparisons. Unknown model IDs cannot earn a model pin. Missing timestamps are not replaced with today's date.

Also recognized:

- OpenAI messages with `tool_calls` and matching `tool_call_id` results.
- Anthropic `tool_use` / `tool_result` blocks, including explicit `is_error`.
- Hermes/OpenClaw message-based JSON/JSONL exports (`message` envelope accepted). Native SQLite stores are not read directly; export messages first.
- OTel `resourceSpans[].scopeSpans[].spans[]`, with `gen_ai.tool.name` or `openinference.span.kind=TOOL`, tool inputs, trace IDs and timestamps.
- Langfuse-style `observations`, Braintrust-style `rows`, and `spans` exports with recognized tool fields.
- Vendor exports under `traces`, `sessions`, `data` or `events`, when their rows contain one of these supported shapes. For Raindrop or custom exporters, normalize to the native contract if no tool events are detected.

Tool-call IDs link calls and results. Text error inference is intentionally conservative: an arbitrary string containing “error” is not enough to assert failure. Exporters should supply structured status/error fields. Unsupported shapes produce a warning or no events, not fabricated evidence.

## Human-flagged proposals

```sh
mirrors flag run-001 --note "Edit failed despite a successful read"
mirrors propose
mirrors propose --apply
```

Proposals group flagged tool failures by tool and normalized error signature. Evidence includes trace IDs and step indices. Drafts always start in shadow. `--all-errors` explicitly broadens discovery to unflagged tool errors. Proposal clustering is deterministic; it does not claim to identify root causes automatically.

`mirrors ask-agent run-001` sends the stored normalized trajectory to its recorded model and asks for a corrective instruction. It does not re-execute tools or prove a counterfactual. Supply `--model` for an unavailable model identifier. Review the printed draft before adding it.
