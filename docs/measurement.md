# Failure signals, release health and fix evidence

## Primitive: the signal

A signal has an immutable ID, a plain-English definition, a deterministic detector (or explicit judgment adapter), a confidence threshold and a human-labeled sample set. Changing the definition requires a new ID. Matching a definition is not equivalent to proving a real-world failure.

Built-in code detectors:

| Signal                      | Observable event                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `invalid-target-error`      | An explicit error identifies a rejected node, selector, old string or target ID                |
| `repeated-identical-error`  | Consecutive identical tool names/argument hashes both explicitly fail                          |
| `unresolved-tool-error`     | A completed run's final recorded tool call failed                                              |
| `success-claim-after-error` | Completion vocabulary in a final message after an unresolved tool error                        |
| `open-without-read`         | A successful open-named tool has no subsequent read/extract/parse-named call                   |
| `step-budget-exceeded`      | More than 25 tool calls by default                                                             |
| `error-ignored`             | An error is followed by a different tool outside the configured naming convention for recovery |
| `empty-result-retry`        | Same search repeated after an explicitly empty result                                          |
| `invalid-target-retry`      | Identical arguments retried immediately after a rejected target                                |
| `tool-not-loaded`           | Explicit missing-tool/loading prerequisite error                                               |
| `write-before-read`         | A write/edit-named call precedes any read/get/inspect/fetch-named call                         |

Names and exact definitions are available in the UI and `signals list`. Several detectors are naming conventions or lexical candidates. Creating a new document legitimately may trigger “write before read”; that is why labels are mandatory for verification. Tests establish that predicates match their definitions on fixtures, not 100% empirical precision on every deployment.

## Labels, precision and coverage

Inspect positive and negative conversations. “Agree” confirms the detector's result at that sample; “disagree” rejects it. Latest labels replace earlier labels for the same signal/run/step and retain the reviewer and timestamp. Run-content changes invalidate labels and retain an audit record; metadata-only changes preserve them. Signal definitions cannot change in place.

- **Affected runs:** distinct indexed runs with at least one hit.
- **Rate:** affected runs divided by assessable runs in the selected time window.
- **Coverage:** assessable runs divided by indexed runs in that window. Missing required evidence is not a negative.
- **Precision:** agreeing positive labels divided by labeled positives.
- **Agreement:** agreeing labels divided by all labeled samples.
- **Reviewed:** at least one positive and one negative sample labeled. This minimal gate is not a statistical guarantee.

A timestamp-less import uses the epoch and falls outside recent windows. Partial runs do not enter release-health denominators. Status-dependent detectors skip runs without known tool status; completion detectors need a final message. Judgment timeouts are “no answer,” never hits or clean negatives.

## Release comparisons

Default selection: latest known version and the preceding known version. Explicit baseline/current IDs are supported. Version hashes derived from captured prompt/code provenance are known; model identity alone is not a deployment version.

Within the rolling window, group completed assessable runs by **signal × intent × segment × version**. Compare failed-run proportions. Report regression when the after rate exceeds the before rate by more than the configured absolute delta (default 0.05), with at least 30 samples on each side in that group. Report improvements by the symmetric threshold; otherwise stable or insufficient.

Show the sample sizes and affected runs with the most hit steps. Do not assign p-values. Traffic mix is partly controlled by grouping, but user changes within segments, model changes, simultaneous fixes and instrumentation changes still confound results. There is no universal within-hour guarantee: alerting needs fresh imports, a running watcher and enough traffic.

Intents are grouping metadata only. The default local feature-hash embedding is a low-cost lexical approximation; it is not a pretrained semantic encoder. Review/naming is important before trusting segment comparisons. Existing intent/segment metadata is preferable.

## Unit: the fix

Each fix maps to one target signal, a type, a shipped version, optional baseline/model pins, status, source and notes. Several fixes in the same deploy share the same measurement. Mirrors says so instead of claiming individual causal credit.

Verification is an explicit operation. It requires a shipped version, a model pin matching that release when present, human-reviewed positive and negative signal samples, adequate samples for all observed groups, at least one improvement and no regression. An insufficient group blocks verification rather than being silently dropped.

Runtime rules can supply a separate session-hash experiment. Their treatment/control recurrence uses explicit terminal run outcomes, documented in [runtime measurement](runtime-measurement.md). It is separate from observational release comparisons.

## Cached-result replay

A replay model receives the conversation prefix with the candidate system prompt and captured tool schemas. Previously replayed assistant messages replace the old assistant messages in later prefixes. Tool results come only from the captured run.

For each model step, compare generated tool names, order and canonical argument hashes with the recorded actions. An exact match allows reuse of cached results. At the first difference, stop and report **diverged**. Missing or explicitly truncated results/schemas yield **unreplayable**. No tool function is installed for execution.

Code signals are evaluated on the aligned prefix. Only completed replay trajectories enter whole-run before/after hit totals; diverged, failed and unreplayable trajectories have separate counts. A changed final answer may affect a lexical signal, but unchanged cached tool outcomes cannot prove that a production defect was fixed.

## Storage

`.mirrors/index.sqlite` contains relational metadata, hashes, signal hits/assessments, labels, versions, fixes/results, optional rule/fire mirrors, intent clusters and replay reports. `model_calls` preserves model-only step hashes; `steps` indexes individual tool calls. Raw original exports plus normalized messages live in `.mirrors/runs/` under content-addressed filenames.

The SQL index is still sensitive: error reasons, fix notes, sources and replay reports may contain text. “Hashes in the index” is not an anonymization guarantee. Nothing uploads by default. The UI exposes raw conversations only over loopback. This release has no hosted tenancy, automatic retention or synchronized team permissions.
