# Measurement

## Live outcomes

Call `Runtime.finish(context, failures?)`, adapter `finish`, or `POST /api/finish` exactly at the end of the host run. The failure predicate runs against the final trajectory window. For a failure that happened anywhere in a run and later recovered, keep your own boolean and pass `{ "rule-id": true }` explicitly if that is the outcome you want to measure. The default repeated-error signal measures unresolved repetition at the end, not every earlier retry.

Each rule/session has one terminal outcome per revision; a later record replaces an earlier one in metrics. Only active, unexpired, matching-pin rules supported by the host enter terminal recurrence. Treatment and control include all eligible completed sessions, even those where the condition never matched (intent-to-treat).

Cohorts are assigned by SHA-256 of the rule ID and session ID. Keep session IDs unique per run and reuse the same ID throughout a run. Active rules use the configured rollout; shadow never changes behavior.

`recurrence_per_1k = 1000 * failed_completed_sessions / completed_sessions`

`lift = (control_rate - treatment_rate) / control_rate`

A zero control rate makes relative lift undefined. There is no manufactured zero for missing data.

## Verdicts

- **Dead weight:** no assessed match after the configured minimum observed runs, in the measurement window. Unsupported phases and unavailable judgments do not count as assessed observations.
- **Working / not working:** at least `expiry.min_runs` terminal sessions in each arm (default 30), a defined failure signal, and an approximate normal 95% difference interval excluding zero.
- **Cannot assess:** insufficient outcomes, no failure signal, or inconclusive difference.

These are exploratory indicators, not proof of causality. Several simultaneously active rules may interact; rare outcomes, repeated sessions from the same user, drift, and multiple comparisons weaken the approximation. Use controlled isolated experiments for stronger claims. This release does not provide multiplicity corrections or sequential-testing guarantees.

Human labels are attached only to actual fired events. The latest label wins. `correct` is positive; `incorrect` and `override` are negatives. Unlabeled fires do not enter precision. Override thresholds can nominate a rule for retirement.

A fire is an engine decision handed to the adapter, not proof that an upstream model obeyed it. A host or upstream failure after evaluation can prevent an intended action. Use terminal outcomes and labels to judge effectiveness.

## Replay

Backtests evaluate code conditions on recorded tool transitions. Judgment conditions are skipped offline. Retrospective failure rates are descriptive rates among historical matching runs, not treatment/control results. Undated exports use an epoch timestamp and are excluded from recent-window backtests until supplied with a real timestamp.

Prompt archaeology reports line candidates, git blame age, history and lexical overlap/possible contradictions. It does not prove semantic equivalence or contradictory behavior. Prompt import is a line heuristic; manually review multi-line instructions.

## Lifecycle and budgets

Expiry and pin mismatches take effect during evaluation. Retirement is applied through `mirrors lifecycle --apply`. The no-lift policy is deliberately conservative: it retires on evidence of worse recurrence, not on an inconclusive sample. Idle retirement needs both elapsed time and enough assessed runs. No rule activates itself.

Budgets deduplicate terminal sessions by failure class. Any positive outcome for that class makes the run a failure. `mirrors budget` exits 2 on a breach; connect that to your existing alerting. Budget rates include both cohorts. Automatic paging and email are not bundled.

`mirrors digest` prints five lines. Optional `--webhook-env NAME` posts those lines to the Slack webhook supplied in the environment. Scheduling and delivery require explicit configuration by the operator.

## Prompt size

Record `mirrors prompt-snapshot ./AGENTS.md` before and after deliberately removing migrated instructions. Snapshots store the path, hash, and approximate token count, not prompt contents. The digest shows the aggregate change from the first to latest snapshot for each path. A negative saving means the prompt grew. This does not estimate requests served or total dollars saved.

## Storage and overhead

Evaluation latency excludes parsing, compilation, telemetry writes, HTTP, and host application of the decision. Judgment latency is included when configured. Local storage is append-only JSONL and per-trace JSON files, intended for a developer workspace, not high-volume centralized ingestion. There is no retention daemon. Archive or remove `.mirrors/` yourself when appropriate. Never commit sensitive trace exports.
