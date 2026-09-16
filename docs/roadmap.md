# Release scope and acceptance evidence

## Implemented

- Existing-file ingestion, message/span normalization, SQLite run/model-call/tool-call index and local raw storage.
- Eleven deterministic signals, inspectable definitions, positive/negative human samples, precision/coverage and a frequency-ranked top-ten view.
- Version/intent/segment release comparisons, sample thresholds, worst-run links, a foreground export watcher and opt-in Slack alerts.
- First-class prompt/code/rule fixes, source/version/model pins, proposed/shipped/verified/retired lifecycle and persisted before/after results.
- Local feature-hash intent embeddings with human naming. Intents never score failures.
- Cached-result model replay with bounded concurrency, deadlines, complete-cache checks and explicit divergence.
- Optional runtime rule engine and framework bridges, shadow/rollout, fail-open behavior and a 300 ms judgment cap.
- Single local UI, conversation viewer, weekly digest and Codex/Claude skill.
- Read-only DocumentDB adapter and file-based export adapters.

## Acceptance checks that need deployment data

The repository has executable fixtures for release regression, shared-deploy attribution, fix verification, replay divergence, timeout and cache completeness. It includes synthetic two-version/three-fix demo data. It does **not** claim:

- Thirty days of live Hermes sessions or a real Hermes rule experiment; a local Hermes installation/session source was not supplied.
- A real two-version customer release diff; existing traces need real deployment tags.
- Three real production fixes verified end to end; those need actual shipped versions, outcomes and human labels.
- Human-validated 100% signal precision; labeling UI exists, but real humans must review samples.
- One hundred paid model replays within ten minutes; runtime depends on trace length/provider speed and captured schemas/results. The batch has a ten-minute deadline and reports incomplete work honestly.
- Live DocumentDB connectivity; that requires read-only credentials, a source schema and network access.
- Full Hermes/OpenClaw production compatibility from contract tests alone.

A local engine microbenchmark supports the code-evaluation budget, not an end-to-end hook-latency claim. Storage and transport add overhead.

## Intentional limits

The local embedding is lexical feature hashing, not a pretrained semantic model. Export support recognizes documented shapes, not every vendor format. Native Hermes SQLite stores require JSON export. The Jev adapter is a no-answer stub. Failure judgments are secondary and opt-in. No automatic semantic root-cause assertion, native Raindrop publishing, email provider or hosted registry is included.

Runtime-rule comparison and release-health comparison are distinct measurements. Rule changes still version the YAML ledger; fix records live in the SQLite index. The SQLite rule/fire tables mirror optional runtime records when the observation UI reads state.

Hosted multi-tenant services, training, stateful world mocking and sandboxes remain out of scope. Automated fix proposal learning is future work after reliable fix-result data exists.
