# Ingestion from existing data

`mirrors ingest PATH` accepts a JSON/JSONL file or directory. It recursively reads JSON/JSONL, skips hidden directories and `node_modules`, normalizes runs, scores code signals, indexes them in SQLite and assigns unclassified intents. Reimporting the same run ID updates the run rather than duplicating it.

## Accepted shapes

- **OpenAI messages:** assistant `tool_calls`, matching `tool_call_id` results, optional root tool schemas and metadata.
- **Anthropic messages:** `tool_use` / `tool_result` blocks and `is_error`.
- **River conversation exports:** `conversation_id`, professional-domain segment, date range, message metadata, tool calls with `resolved_outcome`/execution errors, alternate `user_message` text, and truncated-result markers. Original raw data remains local.
- **Hermes/OpenClaw:** message JSON/JSONL exports, including `message` envelopes. Native SQLite session databases need export to JSON first.
- **OTel:** `resourceSpans[].scopeSpans[].spans[]` with GenAI/OpenInference tool names, inputs, trace IDs, times and status.
- **Langfuse-style** `observations`, **Braintrust-style** `rows`, and generic `spans` exports with recognized tool fields. Raindrop exports work when they contain a recognized message/span shape; otherwise export to the native format below. These are export importers, not authenticated vendor API clients.
- **Native normalized runs:** the Zod contract in `src/observe/schema.ts`, with `steps`, version, model, metadata and captured messages.

Unknown shapes produce warnings, not fabricated tool events. A file can be rejected without preventing other files from importing. Errors, unknown statuses, missing timestamps and missing schemas remain explicit.

## Minimal portable format

For measurement-only data, this simple tool trajectory also works:

```json
{
  "id": "run-001",
  "version": "release-1",
  "model": "actual-model-id",
  "intent": "document-editing",
  "segment": "professional",
  "timestamp": "2026-09-16T10:00:00Z",
  "tools": [
    { "tool": "read_document", "args": { "id": "example" }, "status": "success" },
    {
      "tool": "edit_document",
      "args": { "target": "n1" },
      "status": "error",
      "error": "Invalid target ID"
    }
  ]
}
```

This is enough for applicable tool-sequence signals. It is not enough for replay: replay also needs complete message prefixes, exact tool definitions and cached tool results. Importing an export does not automatically make it replayable.

Pass actual missing metadata explicitly:

```sh
mirrors ingest ./release-1 --version v1 --model actual-model-id
mirrors ingest ./release-2 --version v2 --intent document-editing --segment professional
```

A model alias is preserved as supplied, not resolved to an invented provider model. Date strings without a timezone in River exports represent UTC. For other sources use ISO 8601 timestamps with offsets. Raw/tool-only span imports may have less information than full message exports; coverage and replay readiness show that gap.

## DocumentDB / MongoDB

The adapter uses the MongoDB driver and a read-only `find` cursor. It performs no database writes, disables retryable writes, limits batches/documents, and does not log the connection URI.

```sh
# Set MIRRORS_DOCUMENTDB_URI securely in your shell/environment.
mirrors documentdb --uri-env MIRRORS_DOCUMENTDB_URI \
  --database agent --collection conversations \
  --ca-file /path/to/global-bundle.pem \
  --query '{"created_at":{"$gte":"2026-08-17T00:00:00Z"}}' \
  --limit 10000
```

The collection must contain conversation/message documents or supported exports. The date query's type/field must match the source collection; this example assumes an ISO string field. Native Mongo dates may require a source-specific query adapter. Use credentials with read-only permissions and the CA appropriate for your deployment. The URI is never accepted directly on a command line flag.

A real DocumentDB connection requires your source schema, network access and credentials. Local tests verify normalization/validation without connecting to a customer's database.

## Privacy and missing data

Raw exports can contain sensitive text even if their user IDs are pseudonymous. Keep exports and `.mirrors/` out of git. Measurements do not leave your machine. Replay and judgment scoring are explicit opt-in provider calls; review the included content before using them.

Cached tool results marked truncated are never treated as complete replay evidence. Missing deployment tags prevent release comparison. User-supplied version tags should describe real deploys; do not split historical runs into invented releases to make the table look populated.
