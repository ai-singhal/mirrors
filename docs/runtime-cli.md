# CLI

Use `mirrors --cwd /path/to/project <command>` to target another project. `mirrors --help` and command `--help` are available. Build and `npm link` the source checkout first.

| Command                                           | Result                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `init --with-rules`                               | Create a ledger, refusing to overwrite an existing one                         |
| `validate`                                        | Validate YAML and compile conditions                                           |
| `list [--json]`                                   | Inspect rules                                                                  |
| `add "instruction" [--model ID]`                  | Heuristic scoped draft, in shadow                                              |
| `set ID STATUS [--rollout N]`                     | Change status/rollout                                                          |
| `import prompt FILE [--model ID]`                 | Create shadow candidates pinned to the original prompt hash                    |
| `import traces PATH`                              | Normalize local JSON/JSONL exports                                             |
| `archaeology FILE [--output FILE]`                | Approximate tokens, line candidates, history, age, lexical overlap             |
| `backtest [--days N]`                             | Historical opportunities and descriptive recurrence                            |
| `report [--days N]`                               | Live per-rule metrics and budget breaches                                      |
| `flag TRACE_ID [--note TEXT]`                     | Mark an imported failure for proposals                                         |
| `propose [--apply] [--all-errors]`                | Draft from flagged failures; optionally add in shadow                          |
| `ask-agent TRACE_ID [--model ID]`                 | Explicit external model request for a corrective draft                         |
| `label EVENT_ID correct\|incorrect\|override`     | Human precision/override signal                                                |
| `queue`                                           | List human review events and their decisions                                   |
| `review EVENT_ID approved\|denied`                | Record a review; host controls resumption                                      |
| `prompt-snapshot FILE`                            | Record estimated prompt tokens and compare snapshots                           |
| `rule-digest [--days N] [--webhook-env NAME]`     | Five-line digest; optional explicit Slack delivery                             |
| `budget [--days N]`                               | Exit 2 on budget breaches                                                      |
| `lifecycle [--model ID] [--apply]`                | Preview/apply shadow and retirement changes                                    |
| `upgrade MODEL`                                   | Model-change report and error drafts from that model's imported traces         |
| `evaluate`                                        | Read one Context from stdin, print a Decision; fail open                       |
| `golden ID --output FILE [--format json\|vitest]` | Historical code-condition positive/negative cases; requires a positive example |
| `install PACK`                                    | Install a bundled pack in shadow; no remote registry execution                 |
| `gate [--base REF] [--diff FILE]`                 | Exit 1 when new conditional prompt lines should become rules                   |
| `serve [--port N] [--judge]`                      | Local UI/API, default 7433                                                     |
| `proxy --upstream URL [--port N] [--judge]`       | OpenAI chat-completions proxy, default 7434                                    |
| `demo [--dir PATH]`                               | Create a new, explicitly synthetic example workspace                           |

`golden --format vitest` emits a runnable condition regression test importing this package. The JSON export uses `mirrors-golden-v1`; Raindrop Workshop ingestion needs an importer mapping. It is not a native Workshop API integration.

The prompt-growth gate checks added conditional lines in `AGENTS.md`, `CLAUDE.md` and prompt-named `.md/.txt/.yaml` files. A line containing `mirrors-ignore:` is an explicit exception. The gate does not post comments or alter prompts. See the [example workflow](../examples/prompt-gate.yml).

## Bundled packs

- `loop-breaker@1`
- `document-edits@1`
- `tool-readiness@1`
- `completion-evidence@1`

These are starter hypotheses with no public production-effectiveness badges. The pack version suffix is the bundled catalog version, not an npm dependency.
