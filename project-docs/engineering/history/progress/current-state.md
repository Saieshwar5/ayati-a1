# Current State

Last updated: 2026-07-06

Ayati's active task-continuity path is git-native. The old task-thread and
Activity continuation path is historical and must not be reintroduced into the
model-facing context.

Current harness model:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Current task-continuity model:

```text
daily git context + run recorder + personal memory -> git context pack -> decision state view
```

The model prompt receives a deduplicated grouped projection:

```text
context.timeline + context.git + context.tools + context.harness + context.run + context.personal
```

## Implemented

- Daily git context repositories with task branches.
- Session-store submodule as the canonical session conversation store, with
  per-message Markdown files.
- Pending turn envelope with `unbound`, `bound`, and `clarifying` states.
- Automatic binding for obvious same-task follow-ups.
- Turn-aware task routing tools:
  - `git_context_activate_task_for_turn`
  - `git_context_create_task_for_turn`
  - `git_context_ask_clarification_for_turn`
- Git-context read/search tools for explicit retrieval instead of loading every
  branch into the prompt.
- Grouped prompt context with legacy aliases kept internal for compatibility
  instead of promoted as duplicate model-facing payload.
- Pending-routing guard: normal task tools cannot run while a pending turn is
  unbound or clarifying.
- Fresh-session task gate: when no active task exists, the model sees only
  create-or-clarify routing tools; normal work tools repair back to task
  creation instead of crashing with a missing run.
- Active context refresh after activate/create routing.
- Same-turn continuation after routing: create/activate tools return a real
  run id, routing tools are deactivated, normal work tools are prepared, and the
  agent can complete work in the same user turn.
- Custom refs for active/latest pointers.
- Runtime-owned finalization with duplicate-run protection.
- Run Markdown, action records, evidence manifests, task notes, task assets,
  commit trailers, and recent commit/evidence context.
- Task-run records store `sessionStoreCommit` plus `conversationRefs`, so task
  conversation is reconstructed from the exact session-store snapshot for the
  run.
- Session summary files in the session-store submodule, projected at
  `context.git.session.summary` when present. They are explicit artifacts; the
  runtime does not auto-generate summaries for each message.
- Compact model-facing git-context tool results that do not expose the full
  internal memory cache.
- Hot tool-output observation retention: `next_step`, `while_relevant`, and
  `evidence_only`.
- Prompt-facing read tool context through `context.run.toolCalls.latest`,
  kept separate from durable task state.
- Prompt-facing harness repair feedback through `context.harness.feedback`,
  kept separate from run context.
- Filesystem inspection and efficient read tools:
  - `inspect_paths` for metadata, line counts, content hints, hashes, directory
    counts, and read recommendations.
  - `read_files` for multi-file reads.
  - `read_file` and `read_files` advisory feedback when metadata should be used
    before broad, truncated, or risky reads.
- Tool taxonomy as the source of truth for hidden catalog groups, loading
  priority, tool lifecycles, deterministic follow-up loading, and runtime
  removal policy.
- Smaller purpose-built tool groups, 15 selected executable tools by default,
  and multi-group `decision_load_tools` requests.
- Deterministic file-vs-shell loading: create/build website/app/project intent
  prepares file create/write/read tools, while shell loads for explicit
  run/test/install/start/build-command intent.
- Read-progress policy and feedback for active task runs, aimed at reducing
  repeated read-only loops when the next useful move is write/edit,
  clarification, or a blocked result.
- Context-engine and tool-mode feedback observability: feedback summaries and
  raw events carry compact pending-turn, route source/mode, task/branch/run,
  tool-mode, routing-tool visibility/deactivation, finalization, commit, asset,
  and evidence counts for developer debugging.
- Evidence tools for reading/searching/tailing/chunking saved raw output.

## Runtime Boundary

The agent may search/read git context and express task-routing intent. Runtime
owns branch mutation, pending-turn binding, run id allocation, task state
reduction, finalization, assistant message persistence, and git commits.

Do not expose these as normal model-facing tools:

- `git_context_create_task`
- `git_context_switch_task`
- `git_context_commit_run`
- `git_context_update_task_state`

Do not add `git_context_continue_current_turn`; obvious same-task continuation
is the simple runtime path.

## Remaining Priority

1. Clarification follow-up resolution.
2. Attachment preservation and ownership during pending-turn routing.
3. Broader app/engine-level live-flow coverage beyond the focused agent-loop
   routing tests.
4. App-level finalization coverage for completed, failed, blocked,
   needs-user-input, stuck/max-iteration, and tool-failure outcomes.
5. System-event parity with chat pending-turn routing and finalization.
6. Legacy cleanup around historical focus/message-link/event files.
7. Stable milestone tags.
8. Advanced raw-context lifecycle only if real usage proves read context,
   observation retention, and evidence tools are not enough.
