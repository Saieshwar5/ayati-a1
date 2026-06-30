# Current State

Last updated: 2026-06-30

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

## Implemented

- Daily git context repositories with task branches.
- Markdown conversation as canonical conversation context.
- Pending turn envelope with `unbound`, `bound`, and `clarifying` states.
- Automatic binding for obvious same-task follow-ups.
- Turn-aware task routing tools:
  - `git_context_activate_task_for_turn`
  - `git_context_create_task_for_turn`
  - `git_context_ask_clarification_for_turn`
- Git-context read/search tools for explicit retrieval instead of loading every
  branch into the prompt.
- Pending-routing guard: normal task tools cannot run while a pending turn is
  unbound or clarifying.
- Active context refresh after activate/create routing.
- Custom refs for active/latest pointers.
- Runtime-owned finalization with duplicate-run protection.
- Run Markdown, action records, evidence manifests, task notes, task assets,
  commit trailers, and recent commit/evidence context.
- Compact model-facing git-context tool results that do not expose the full
  internal memory cache.
- Hot tool-output observation retention: `next_step`, `while_relevant`, and
  `evidence_only`.
- Context-engine feedback observability: feedback summaries and raw feedback
  events now carry compact pending-turn, route source/mode, task/branch/run,
  finalization, commit, asset, and evidence counts for developer debugging.
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
2. Engine-level create-new-task live flow coverage.
3. Attachment preservation and ownership during pending-turn routing.
4. App-level finalization coverage for completed, failed, blocked,
   needs-user-input, stuck/max-iteration, and tool-failure outcomes.
5. System-event parity with chat pending-turn routing and finalization.
6. Legacy cleanup around historical focus/message-link/event files.
7. Stable milestone tags.
8. Advanced raw-context lifecycle only if real usage proves retention plus
   evidence tools is not enough.
