# Engine microbenchmark

Measured locally on 2026-09-16, Node.js 22.22.1, macOS x64. Run `npm run bench` to reproduce on your machine.

| Workload            | Result                                                    |
| ------------------- | --------------------------------------------------------- |
| Rules               | 500 active code rules, two-clause conditions, 50% rollout |
| Input               | Two repeated failed calls; synthetic                      |
| Warm-up             | 300 evaluations                                           |
| Measured iterations | 1,000 with distinct session IDs                           |
| p50                 | 0.424 ms                                                  |
| p95                 | 0.575 ms                                                  |
| p99                 | 3.371 ms                                                  |

This measures in-process predicate evaluation, cohort assignment, conflict resolution and creation of decision records. It excludes schema compilation, YAML reads, JSONL persistence, HTTP, host application of decisions and model judgments. It is not end-to-end adapter overhead or a production-effectiveness benchmark.

The script exits nonzero if p95 exceeds 5 ms. This threshold is intentionally not a shared-runner CI gate because machine load and hardware vary. The benchmark data and the UI demo are synthetic; no production traces are distributed.

## Functional validation

- 88 TypeScript tests: runtime invariants, fail-open behavior, shadow/control, conflicts, timeouts, trace normalization, metrics, local HTTP, proxy streaming, actual AI SDK model loop, proposal flags, prompt snapshots and review records.
- 8 Python tests: local client failure handling, Hermes hook contract, actual Pydantic AI TestModel/toolset, actual LangGraph graph and tool blocking.
- 5 Playwright tests: author/edit/status persistence, import, mobile overflow, human review.
- TypeScript declarations and production UI build.

The observation suite also checks eleven positive/negative detector fixtures, traffic-mix changes, missing version tags, shared deploys, fix verification gates, persistent labels and intent names, OTel normalization, truncated replay caches and deadlines.

Framework hook fixtures do not replace testing in a real Hermes/OpenClaw deployment. Model judgment calls require credentials and were not exercised against a paid provider.
