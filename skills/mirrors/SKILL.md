---
name: mirrors
description: Draft and evaluate scoped behavioral rules in a project's Mirrors ledger. Use when a recurring agent failure needs a conditional fix, a prompt is accumulating behavioral instructions, or the user asks to import, measure, or retire Mirrors rules.
---

# Mirrors behavioral rules

Use the project's `mirrors.yaml` to turn a repeated failure into a condition that can be observed and reviewed. The CLI is `mirrors`; use `mirrors --cwd <project>` when working elsewhere. If it is unavailable, explain the source-install prerequisite rather than pretending a rule was applied.

## Draft a fix

1. Inspect the failing tool transition and existing rules. Distinguish a tool contract defect from behavior the agent can change. A reminder cannot repair an incompatible reader/writer ID format.
2. Run `mirrors add "When <observable situation>, <specific behavior>"`, or flag an imported trace and use `mirrors propose --apply`. Both create shadow drafts.
3. Read the generated YAML. Replace broad judgments with observable code predicates when the trace supports them. Scope the rule to the relevant tools/statuses; include a meaningful terminal failure signal where possible.
4. Run `mirrors validate` and `mirrors backtest`. Explain the rule, evidence, and measurement gap. A replay match does not prove a fix.

Activation requires an explicit user instruction to activate the specific rule; creating a shadow draft does not require another approval when already requested. Preserve any user-authorized rollout. Never activate a draft merely because a historical condition matched.

## Keep the prompt reviewable

Prefer a scoped ledger rule for a new conditional behavioral instruction when it fits the user's goal. Do not remove existing prompt text automatically. When the user requests migration, record `mirrors prompt-snapshot <file>` before and after the edit, and update the prompt pin deliberately.

Do not move task requirements, identity, tool schemas, or permission boundaries into fallible behavioral guidance. Mirrors is fail-open and cannot enforce security policy.

## Measure and retire

Inspect `mirrors report`, actual fire labels, treatment/control counts and the failure definition. “Cannot assess” is valid. Keep a control cohort when assessing lift. Preview `mirrors lifecycle` or `mirrors upgrade <model>` and apply only within the user's requested scope. Record overrides with `mirrors label <event-id> override`.

Agent-suggested corrections remain drafts. `ask-agent` sends a trace to a model; use it only when that external analysis is within the user's request. Keep private traces and `.mirrors/` out of git. Do not schedule messages or publish registry claims as a side effect of authoring a rule.
