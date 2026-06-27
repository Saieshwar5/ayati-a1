# Runtime Data

Runtime output lives under `ayati-main/data/`.

Known runtime data categories:

- Daily git context repositories and task work branches.
- Run/session recorder data.
- Personal memory.
- Episodic memory metadata and vector indexes.
- Document storage and document vectors for prepared document compatibility.
- Managed attachment library: files under `data/files/`, directory manifests
  under `data/directories/`, and run attachment manifests under `data/runs/`.
- Runtime provider configuration.
- Generated run artifacts.
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
warning flags, and the raw JSONL path. The raw trace remains the source of
truth and includes compact decision input state, tool-load results, action
verification data, tool-result previews, final response data, and task summary
counts.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
