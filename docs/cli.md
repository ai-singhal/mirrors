# CLI reference

Build and link the source checkout first. Use `mirrors --cwd /path/to/project COMMAND` to target another workspace.

## Existing traces → failure signals

```sh
mirrors init                          # no runtime rules installed by default
mirrors ingest ./sessions             # JSON/JSONL file or recursive directory
mirrors ingest ./before --version v1 --model actual-model-id
mirrors ingest ./after --version v2 --intent document-edit --segment professional
mirrors signals list --days 30
mirrors signals samples invalid-target-error
mirrors inspect RUN_ID
mirrors signals label invalid-target-error RUN_ID --step 3 --agree yes --by reviewer
mirrors signals label invalid-target-error NEGATIVE_RUN_ID --step -1 --agree yes
```

Labels mean “agree/disagree with the detector's result.” `--step -1` labels a run-level negative. Signal definitions are immutable: use a new signal ID when changing a definition so old human samples cannot silently validate a different detector.

```sh
mirrors signals add custom-budget --name "50-call ceiling" \
  --definition "More than 50 tool calls" --detector step-budget-exceeded --budget 50
mirrors signals score
mirrors signals add unsupported-claim --name "Unsupported claim" \
  --definition "The final answer claims a fact contradicted by the captured results" \
  --judgment --confidence 0.9
mirrors signals score --judge         # explicit external model calls, capped at 300 ms
```

The Haiku adapter uses `ANTHROPIC_API_KEY` or `AI_GATEWAY_API_KEY`; `MIRRORS_JUDGE_MODEL` overrides its default. The Jev interface is a no-answer stub, not a live integration.

## Versions and release health

```sh
mirrors versions list
mirrors versions add v2 --model actual-model-id --code-ref COMMIT_SHA \
  --deployed-at 2026-09-16T10:00:00Z
mirrors health --baseline v1 --version v2 --days 30 --min-runs 30 --delta 0.05
mirrors watch ./sessions --interval 60
```

`--intent` and `--segment` filter health comparisons. `ingest --prompt-hash` and `--code-ref` can supply version provenance. `--version` is an operator assertion; use an actual deployment ID, not a made-up split of historical data.

The watcher is a long-running foreground process. Ctrl-C stops it. It does not install a scheduler or alter the host agent. `--webhook-env NAME` enables explicit Slack delivery on changed regressions. Minimum polling interval is ten seconds.

## Track a fix

```sh
mirrors fix add "Reject invalid writer IDs before submission" \
  --type code --signal invalid-target-error --source COMMIT_SHA --id writer-validation
mirrors fix ship writer-validation --version v2 --baseline v1 --model actual-model-id
mirrors fix results writer-validation
mirrors fix verify writer-validation
mirrors fix retire writer-validation
mirrors fix list
```

Types: `prompt`, `code`, `rule`. Statuses: `proposed`, `shipped`, `verified`, `retired`. A shipped/verified fix requires a version. `verify` checks evidence rather than blindly setting a status. It requires a reviewed positive and negative sample for the signal, sufficient per-intent/segment outcomes, at least one improvement and no observed regression. Shared deploys remain explicitly confounded.

```sh
mirrors fix import-prompt AGENTS.md --signal repeated-identical-error
mirrors fix add "When the same tool call fails twice, inspect the error" \
  --type rule --signal repeated-identical-error
```

Prompt import creates proposed fix records without editing the prompt. A rule fix creates a linked shadow rule in `mirrors.yaml`; activation remains explicit in the runtime page or `mirrors set RULE_ID active --rollout 50`.

## Name task types

```sh
mirrors intents cluster
mirrors intents name intent-HASH "Document editing"
```

Ingestion automatically assigns unclassified runs to local feature-hash embedding clusters. The input is the first user message and first two tool names/argument keys. These are approximate lexical groups, not semantic model embeddings. Human names are stored locally and survive reimport. Supplied intent metadata takes precedence. Intents never participate in signal detection.

## Replay

```sh
mirrors replay invalid-target-error --model provider/model \
  --prompt candidate-system.txt --tools recorded-tools.json \
  --limit 100 --concurrency 4 --output replay-report.json
```

Explicit model calls; zero live tools. `--tools` is optional when schemas were captured. Divergent or incomplete prefixes cannot become passes. The default batch deadline is ten minutes and individual model calls time out after thirty seconds. Reports also appear in the local UI.

## Digest and UI

```sh
mirrors digest --days 7
mirrors digest --webhook-env MIRRORS_SLACK_WEBHOOK
mirrors serve --port 7433
mirrors demo --dir /tmp/mirrors-demo
```

`release-digest` aliases `digest`. `rule-digest` is the older optional-runtime-only digest. Schedule weekly delivery yourself; no messages are sent by default.

## Advanced runtime tools

Existing rule import, add, backtest, golden case, gate, budget, lifecycle and proxy commands remain available. See [runtime CLI reference](runtime-cli.md). They are optional mechanisms, not prerequisites for measurement. The hosted registry and automatic fix-proposal loop are not part of this release.
