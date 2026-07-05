# Runtime Data

Runtime output lives under `ayati-main/data/`.

Known runtime data categories:

- Daily git context repositories and task work branches.
- Run/session recorder data.
- Personal memory.
- Episodic memory metadata and vector indexes.
- Document storage and document vectors for prepared document compatibility.
- Managed attachment library: files under `data/files/`, directory manifests
  under `data/directories/`, per-run attachment manifests under
  `data/run-attachments/`, and prepared attachment caches under
  `data/prepared-attachments/`.
- Runtime provider configuration.
- Python execution scratch and generated Python artifacts under `data/python/`.
- Agent feedback traces under `data/feedback/`.
- System-event queues.
- Plugin state.
- SQLite tool database.

## Feedback Traces

When feedback tracing is enabled, Ayati writes ordered JSONL events to:

```text
ayati-main/data/feedback/YYYY-MM-DD/session-<sessionId>.jsonl
```

The latest raw trace is discoverable through:

```text
ayati-main/data/feedback/latest.json
```

Developer agents should start with:

```text
ayati-main/data/feedback/latest-summary.json
```

That summary is intentionally small. It includes final status, response kind,
iterations, tool-call counts, tool-load/action counts, verification flags,
warning flags, compact git-context routing/finalization state, and the raw
JSONL path. The context-engine portion can show pending-turn status, route
source/mode, task id, branch/ref, run id, commit, committed/skipped/failed
finalization state, and small task evidence/asset counts.

The raw trace remains the source of truth and includes compact decision input
state, tool-load results, action verification data, tool-result previews, final
response data, task summary counts, and context-engine lifecycle events such as
prepared, routed, agent-routed, clarification-requested, finalization-skipped,
finalization-failed, and committed.

Ayati no longer writes harness-local run directories such as
`data/runs/<runId>/state.json`, `step-records.jsonl`, `steps/*.md`, `raw/*.txt`,
or optimization summary files. Agent-facing run context stays in memory during
the run, and durable task/run memory is finalized through the git context
engine.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
