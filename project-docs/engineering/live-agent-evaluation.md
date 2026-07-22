# Live Agent Evaluation

Ayati agent evaluation observes the ordinary persistent daemon through its real
provider, client transport, Context Engine, memory, resources, tools,
schedulers, and configured runtime state. It never substitutes a mock decision
provider, scripted agent output, evaluator prompt, alternate root, or paused
background service.

```text
coding agent -> normal WebSocket client path -> ordinary Ayati daemon
                                      |
                                      -> passive local evidence recorder
```

## Start a Session

```bash
pnpm eval:agent -- live --name <name>
```

Use `--watch` for the normal development rebuild/restart path and `--capture
safe` when exact local text is not appropriate. Exact local capture is the
default. Both modes redact recognized credentials. The command prints the
evaluation id, `ws://localhost:8080`, and the evidence directory.

The daemon still uses the configured `AYATI_ROOT_DIR`; evaluation data is kept
separately under:

```text
ayati-main/data/evaluations/<evaluation-id>/
  session.json
  events.jsonl
  artifacts/<sha256>.json
  operations/<operation-id>.json
  requests/<request-id>.json
  runs/<run-id>/
    evidence.json
    findings.json
    report.json
    report.md
  session-report.json
  session-report.md
```

This directory is ignored, permission-restricted, never uploaded, and never
mounted into Context Engine, a workstream, a resource, or agent notes.

## Adaptive Real-Daemon Workflow

Connect with the ordinary CLI or WebSocket client. For each message:

1. send one normal user message;
2. wait for `reply`, `feedback`, `error`, `reply_done`, or a final
   `notification`;
3. wait for durable finalization acknowledgement;
4. inspect the generated run report;
5. choose the next message from the observed evidence.

Useful scenarios include conversation, resource reads, mutation, continuation,
ambiguous routing, recovery, and measured context pressure. Keep real
mutations small and intentional: evaluation mode grants no extra authority and
the agent can perform the same real work as an ordinary user request.

## Inspect and Annotate

```bash
pnpm eval:agent -- inspect --evaluation <id> --latest
pnpm eval:agent -- inspect --evaluation <id> --run <run-id>
pnpm eval:agent -- report --evaluation <id>
pnpm eval:agent -- annotate --evaluation <id> --run <run-id> \
  --scenario <label> \
  --intended-outcome <text> \
  --usefulness <text> \
  --suspected-issue <text> \
  --experiment <text>
```

Reports contain deterministic facts and diagnostics, not an LLM judge. They
link exact canonical model requests, provider-native outbound payloads,
responses, usage/cost, prompt manifests, context-compilation receipts, tools,
verification, WorkState, resources, finalization, and transport evidence. SDK
retry counts remain `not_exposed` unless an SDK actually exposes them.

The coding agent owns causal interpretation and proposed experiments. There is
no overall score; correctness, reliability, context, token efficiency,
latency, tool behavior, and practical usefulness remain separate.

## Compare Real Sessions

```bash
pnpm eval:agent -- compare --baseline <id> --candidate <id>
```

Comparison reads only recorded live sessions. Reuse annotation scenario labels
when repeating the same real workflow. Compare outcome evidence, requests,
tokens, cache use, cost, latency, tools, and user/coding-agent usefulness; do
not compare a real run to a mock or scripted conversation.

## Prune Safely

```bash
pnpm eval:agent -- prune --older-than <days>
pnpm eval:agent -- prune --keep <count>
pnpm eval:agent -- prune --older-than <days> --confirm
```

Prune is preview-only without `--confirm`. Every target is resolved beneath
the evaluation root and the preview prints its exact path and byte count.

## Capture Semantics

One async context correlates evaluation, stream, run, lane, iteration, logical
operation, request, and span identities. Explicit model purposes distinguish
main decisions, decision repairs, application-visible provider retries, final
responses, checkpoint/focus summaries, memory
consolidation, proposal reflection, and context extraction. Unrelated daemon
work is retained as `background_unattributed`.

Append-only JSONL is the event source. Exact payloads are credential-sanitized,
content-addressed artifacts, while indexes and reports are atomic. Writes are
queued and recorder overhead is measured. Recorder failures never fail a user
run; they degrade capture health and produce capture-gap findings.

Per-run report generation is queued after terminal dispatch. It does not block
the next serialized turn; explicit inspection checkpoints and daemon shutdown
drain queued events and reports. Run totals separate foreground from
background model operations and provider requests. A deterministic resolve
gate event carrying a model-operation or provider-request identity is an
invariant failure.

## Legacy Feedback Aliases

`pnpm dev:main:feedback` and `pnpm start:main:feedback` now enter this same live
evaluation path. `pnpm feedback:context-engine` renders the unified latest
session report, whose Context Engine section is correlated with provider,
tool, WorkState, resource, finalization, and transport evidence.

## Developer Diagnostics Are Not Evaluations

`pnpm --filter ayati-main bench:runtime` measures local subsystem performance.
It does not measure agent quality and must not run inside a live evaluation,
because the extra CPU, filesystem, database, queue, and server load would
change the observed daemon. A separately produced diagnostic report may be
linked manually while investigating a hotspot measured in a live session.
