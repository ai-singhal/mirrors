# Release scope

## Implemented in 0.1

A functional local-first core: YAML ledger, validated runtime predicates, bounded optional structured judgments, deterministic rollout, phase/capability-aware actions, terminal recurrence metrics, human feedback, budgets, explicit lifecycle application, prompt/trace imports, retrospective replay, git archaeology, corrective-model drafts, flagged failure proposals, prompt snapshots, golden condition cases, bundled packs, prompt-growth gate, local UI and review queue. TypeScript and Python integration surfaces are included.

## Deliberate boundaries

- Cloud teams, RBAC, hosted retention, a public registry and cross-customer priors are not implemented.
- Vendor trace support imports exported data; it does not authenticate to Langfuse, Raindrop or Braintrust APIs. Not every vendor format is recognized.
- Framework hook contracts are covered with tests; full Hermes/OpenClaw installations and paid model calls have not been exercised in this repository's test suite.
- The judgment adapter supports Haiku/provider models. No Jev integration is claimed. Failure signals are code predicates or explicit host-supplied booleans; model-judged failure signals are future work.
- Prompt import and archaeology are heuristics. They do not use a semantic contradiction solver or recover every deleted historical instruction.
- Golden exports verify conditions. A native Raindrop Workshop publishing integration is future work.
- Human review records a decision; the host owns suspension/resumption and any replayed operation. No autonomous approval is implied.
- Lifecycle, digest and budget checks are CLI operations for an operator's scheduler. Slack delivery is opt-in; email/paging providers are not bundled.
- The no-lift policy requires evidence of harm before retirement; inconclusive rules remain review candidates.
- JSONL persistence suits a local developer tool. Multi-process telemetry coordination, high-volume retention and durable transactional run snapshots need further work.
- Rule versions include all rule fields, so even note/status/rollout edits start a new measurement revision.

## Evidence before marketing

The included benchmark is an engine microbenchmark on synthetic trajectories. The UI demo is synthetic. No production recurrence reduction, wrong-fire rate, cost savings or cross-customer effectiveness is asserted. A public effectiveness benchmark requires consenting real deployments and labeled outcomes first.
