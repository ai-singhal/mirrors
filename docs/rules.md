# Rule reference

The exported Zod schemas in `src/schema.ts` are authoritative. `mirrors validate` validates the ledger and compiles code conditions. Unknown ledger/rule fields, duplicate IDs, invalid status values and excessive condition nesting are rejected.

## Fields

| Field                          | Meaning                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `id`, `name`, `description`    | Stable ID, display name and context                                     |
| `condition`                    | `code` predicate or `judgment` question                                 |
| `actions`                      | One or more interventions                                               |
| `status`                       | `off`, `shadow` (default), `active`, `retired`                          |
| `rollout`                      | Treatment percentage, 0–100; default 10                                 |
| `priority`                     | Higher wins; ties sort by ID                                            |
| `source`                       | `kind`: manual/prompt/trace/pack/agent; optional ref, line, commit      |
| `pinned`                       | Optional exact `model` and `prompt_hash`                                |
| `expiry`                       | `expires_at`, `idle_days`, `no_lift_days`, `override_limit`, `min_runs` |
| `failure`                      | Named failure class and deterministic terminal predicate                |
| `owner`, `notes`, `created_at` | Review context                                                          |

## Conditions

```yaml
condition:
  type: code
  when:
    all:
      - { field: last.tool, op: eq, value: edit_document }
      - { field: last.status, op: eq, value: error }
      - any:
          - { field: last.error, op: contains, value: selector }
          - { field: last.error, op: contains, value: node }
```

Use `all`, `any`, `not`, or `{field, op, value}`. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `exists`. Numeric comparisons require numbers. String `contains` ignores case. `eq` compares scalar values. `in` takes an array as its value. `exists` needs no value.

Available fields include `session_id`, `model`, `prompt_hash`, `intent`, `phase`, `step`, `tools`, `proposed.tool/args/status`, `last.tool/args/status/error/args_hash`, `repeat_count`, `consecutive_errors`, and numeric dot paths into `trajectory`. Conditions inspect the last 100 tool events. Arguments are hashed in canonical key order. Repeat count counts consecutive matching tool names and arguments; with a proposed call, it counts previous matching calls, excluding the unexecuted proposal.

```yaml
condition:
  type: judgment
  question: Is the agent repeating a failed lookup without changing its query?
  confidence: 0.9
  timeout_ms: 300
```

Enable remote judgments explicitly with `mirrors serve --judge`. Set `ANTHROPIC_API_KEY` for the default Haiku model, or `AI_GATEWAY_API_KEY` for the gateway. Override with `MIRRORS_JUDGE_MODEL`. The adapter uses structured yes/no output. Missing credentials, timeout, error, or insufficient confidence skips that judgment. At most eight applicable judgment rules run concurrently per evaluation; excess judgment rules are skipped. You can supply your own `Judge` function to `Runtime`.

## Actions and phase

| Action       | Fields           | Phase                                            |
| ------------ | ---------------- | ------------------------------------------------ |
| `inject`     | `text`           | Before model request                             |
| `mask_tools` | `tools: [names]` | Before model request                             |
| `force_tool` | `tool`           | Before model request                             |
| `swap_model` | `model`          | Before model request                             |
| `block`      | `reason`         | Before tool execution                            |
| `human`      | `reason`         | Before tool execution; blocks and records review |

At most one injection, force and model selection wins per evaluation. Masks compose; a mask defeats a conflicting forced tool. Unsupported actions/phases are skipped before condition evaluation. A forced tool must be in the host's available tool list. The host must enforce decisions before side effects.

Injection appends a user tail message; it does not edit system text or existing messages. Masks filter available tool names/payload entries without rewriting tool schemas. Provider prompt-cache behavior still depends on its caching rules: changing the available tools can affect cache reuse.

## Pins, lifecycle and revisions

A missing or mismatched pin makes an active rule effectively shadow at runtime. Imported prompt candidates are pinned to the original text hash; pass the exact hash from the host. Prompt removal changes that hash, so update the pin deliberately when reviewing the migration. Expired rules do not intervene.

`mirrors lifecycle` previews persistent retirement/shadow changes; `--apply` writes them. This command is not a background scheduler. Set it up in your own scheduler if desired. Explicit activation and 0%/100% rollout are supported. Changing rule content, status, rollout, notes or pins creates a new measurement revision; previous events remain in the audit log.

Use one runtime/client per run when possible. In-process callers may call `reload()` between runs. The local API reloads on evaluations so UI changes take effect; keep the ledger fixed during a measurement experiment to avoid mid-run configuration changes. Reverting the same rule content returns to its prior revision's evidence.
