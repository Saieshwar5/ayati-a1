# Runtime Data

Ayati uses one managed root:

```text
<AYATI_ROOT_DIR>/
  workspace/              preserved user-visible outputs
  workstreams/            context-only Git repositories
  .ayati/
    context.db
    context.db-wal
    context.db-shm
    resources/
```

The daemon also keeps non-Git runtime data in its configured data directory,
including personal/episodic memory, compact debug feedback, provider settings,
document indexes, Python scratch data, plugin state, and event queues. Live
evaluation evidence is isolated beneath `data/evaluations/`. Do not commit
generated runtime state.

SQLite is authoritative for operational lifecycle and resource metadata.
`workstreams/` is the portable context history. `workspace/` and user-selected
external paths hold real resources. Do not edit SQLite or context repositories
while Context Engine is running.

## Live Evaluation Evidence

The supported passive evidence source is created by:

```bash
pnpm eval:agent -- live --name <name>
```

Schema-versioned sessions, append-only events, content-addressed sanitized
artifacts, model operations, provider requests, run evidence/findings, and
atomic Markdown/JSON reports live under
`ayati-main/data/evaluations/<evaluation-id>/`. Run
`pnpm eval:agent -- inspect --evaluation <id> --latest` after each terminal
turn or `pnpm eval:agent -- report --evaluation <id>` for the unified session
view, including Context Engine lifecycle evidence.

The legacy feedback ledger remains a compact debugging source for ordinary
development, not an agent evaluation.

## Compact Debug Feedback

Feedback is opt-in. With `AYATI_TEST_AGENT=1` and `AYATI_FEEDBACK_TRACE=1`,
ordered JSONL is written beneath the daemon feedback directory. Start with:

```text
feedback/latest-summary.json
feedback/triage-summary.json
feedback/latest-session.json
```

The compact summary includes outcome, stop reason, tool/step counts,
verification, virtual-mode transitions, deterministic binding attempts,
validation attempts, request decision, context-repository identity, resource
count, observation/checkpoint facts, resource effects, before/after context
HEAD, and context-commit status. `navigation` distinguishes transition,
binding-gate, and validation outcomes; `contextEngine.workstreamLifecycle`
groups:

- repository identity, selection mode, health, and HEADs;
- request decision, identity, status, and creation result;
- run identity and binding state;
- finalization outcome, validation, commit creation, and commit identity.

The raw trace records events including `run_started`,
`run_workstream_bound`, `run_step_persisted`, resource mutation preparation and
verification, finalization start/completion/failure, and workstream context
commits.

Event recording performs only bounded in-memory normalization and enqueueing
during a run; filesystem writes and report generation remain queued. Terminal
report checkpoints are scheduled after dispatch and do not hold the serialized
chat or system-event turn. Explicit `checkpoint`, `flush`, and daemon shutdown
still provide a deterministic drain boundary for tests and evaluation capture.

`pnpm feedback:context-engine` now aliases the unified latest live-evaluation
report instead of maintaining a second Context Engine report surface.

## Archive and Rebuild

`pnpm context:archive-reset` only prints resolved paths. With `--confirm`, it
archives the database including WAL/SHM, managed resources, and
workstreams into a timestamped sibling archive with a manifest. It preserves
`workspace/` and refuses broad paths or a live Context Engine writer.

`pnpm context:catalog-rebuild` scans validated context repositories and previews
the reconstructible workstream/resource catalog. `--confirm` requires an empty
initialized V7 database and a stopped daemon.
