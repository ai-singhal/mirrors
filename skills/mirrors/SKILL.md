---
name: mirrors
description: Track a production-agent fix from its target failure signal through a shipped version and before/after evidence. Use when editing agent code or prompts to address a recurring failure, reviewing release regressions, labeling trace signals, or creating an optional scoped runtime rule.
---

# Mirrors: know, fix, verify

The unit is the **fix**. The failure signal is the measurement primitive. Runtime rules are one opt-in fix type.

## Register the change you are making

1. Inspect existing evidence with `mirrors signals list`, `mirrors signals samples SIGNAL_ID`, and `mirrors inspect RUN_ID`. Match a precise definition to the failure; do not confuse infrastructure defects with behavior a reminder can correct.
2. After an authorized code/prompt change, register it:

   ```sh
   mirrors fix add "What changed" --type code --signal SIGNAL_ID --source COMMIT_OR_FILE
   ```

   Use `--type prompt` for a prompt edit. Use `--type rule` when the correction is a scoped “when X, do Y” and runtime intervention fits the user's goal. This creates a linked shadow rule in `mirrors.yaml`.

3. Pin the actual shipped version with `mirrors fix ship FIX_ID --version VERSION --baseline PREVIOUS_VERSION`. Do not invent version tags, commits or deploys. Until shipped, keep the fix proposed.
4. Run `mirrors fix results FIX_ID`. Use `mirrors fix verify FIX_ID` only when the user requested verification and there are adequate outcomes and reviewed positive/negative samples. Report shared-deploy confounds.

## Evidence rules

Code signals are deterministic about their definitions, not automatically correct about user intent. Human sample labels are required; never label yourself as a human or fabricate samples. Missing data and “insufficient” are valid results. Intents group runs; they never detect failures.

Replay calls only the model and substitutes cached tool results. It must stop at divergence. Use `mirrors replay SIGNAL_ID --model MODEL` only when sending the captured prefixes to that provider is within the user's request. Do not execute real tools to make replay pass.

## Optional runtime fixes

Read and review the drafted condition and action. Prefer a code predicate when evidence supports it. `mirrors validate` checks the ledger. All drafts start in shadow; activation needs an explicit user instruction for that rule and rollout. Prior authorization remains valid.

Do not automatically remove prompt instructions or move authorization boundaries into fail-open rules. For a user-requested migration, snapshot prompt size before/after and update pins deliberately. A reader/writer ID mismatch usually needs a contract fix; another reminder cannot repair the API.

## Local first

Import existing sessions with `mirrors ingest PATH`; no SDK wrapper is required. Keep raw exports and `.mirrors/` out of git. Do not publish customer recurrence numbers, schedule messages or call an external provider as a side effect of registering a fix. If the CLI is missing, use the source-install instructions rather than claiming a fix was recorded.
