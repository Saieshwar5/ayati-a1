# Runtime Data

Most daemon runtime output lives under `ayati-main/data/`. Managed session data
defaults to `ayati-main/work_space/.ayati-context/`; task repositories default
to `ayati-main/work_space/tasks/`. Both are outside source control.

Known runtime data categories:

- Git Context operational state under `ayati-main/data/context-engine/` by
  default: `context.sqlite` and the managed Unix socket.
- Git Context session repositories under `AYATI_GIT_CONTEXT_DATA_ROOT` and task
  repositories under the configured workspace's `tasks/` directory.
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
ayati-main/data/feedback/latest-session.json
```

Developer agents should start with:

```text
ayati-main/data/feedback/latest-summary.json
```

That summary is intentionally small. It includes final status, response kind,
iterations, tool-call counts, tool-load/action counts, verification flags,
warning flags, compact git-context routing/finalization state, and the raw
JSONL path. For a selected task, `contextEngine.taskLifecycle` is the canonical
compact operator view. It groups four related records:

- `repository`: task id, stable working directory, selection mode, task
  creation flag, branch, and before/after HEAD;
- `request`: the explicit `initial`, `continue`, or `create`
  decision, request id/status, and whether that selection created a request;
- `run`: run id and whether it has an immutable task binding; and
- `finalization`: lifecycle status, outcome, validation, commit identity,
  commit-created flag, and before/after HEAD.

The raw trace remains the source of truth and includes compact decision input
state, tool-load results, action verification data, tool-result previews, final
response data, and lifecycle events such as `run_started`, `run_task_bound`,
`run_step_persisted`, `run_finalization_started`,
`run_finalization_completed`, `run_finalization_failed`, and
`task_commit_created`.

`triage-summary.json` deterministically checks V1 invariants such as a missing
working directory, a missing or contradictory
request decision, and a final commit that differs from task HEAD. A
clarification that finalizes an unbound run is valid and is no longer
misreported as an incorrectly task-bound clarification. Consistent lifecycle
completion is separate from user-goal success: failed validation and
`incomplete`, `failed`, `blocked`, or `needs_user_input` task outcomes remain
visible as review findings. A valid no-change finalization explicitly reports
`commit.status="no_change"` rather than fabricating a commit identity.

Ayati no longer writes harness-local run directories such as
`data/runs/<runId>/state.json`, `step-records.jsonl`, `steps/*.md`, `raw/*.txt`,
or optimization summary files. Agent-facing run context stays in memory during
the run, and durable task/run memory is finalized through the git context
engine.

Daemon-managed Git Context paths can be overridden with:

- `AYATI_GIT_CONTEXT_STORE_DIR`
- `AYATI_GIT_CONTEXT_DATA_ROOT` (with `AYATI_GIT_CONTEXT_DATA_DIR` accepted as
  a compatibility alias)
- `AYATI_GIT_CONTEXT_DATABASE`
- `AYATI_GIT_CONTEXT_SOCKET`

`AYATI_GIT_CONTEXT_WORKSPACE_DIR`, `AYATI_GIT_CONTEXT_DATA_DIR`, and
`AYATI_GIT_CONTEXT_PARENT_PID` are child-process inputs set by the managed
daemon or used when running the Git Context server directly; they are not a
second repository model.

The context catalog and run journal are operational SQLite state. Session and
task repositories are durable Git state. Do not edit either directly while the
server is running; use the typed Git Context protocol.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
