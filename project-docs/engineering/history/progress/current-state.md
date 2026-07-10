# Current State

Last updated: 2026-07-10

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
- Run-first session lifecycle for provider-handled chat turns and system
  events:
  - every provider-handled turn starts as a session run,
  - read-only tools can execute before task binding,
  - new-task targets can be recorded without creating a durable task,
  - clarification turns finalize as session-only runs,
  - clarification answers start fresh and promote only if that answer mutates,
  - mutation promotes the active session run into a task run,
  - unpromoted runs finalize in `session-store`,
  - promoted runs finalize only in the task directory using the same run id.
- Grouped prompt context with legacy aliases kept internal for compatibility
  instead of promoted as duplicate model-facing payload.
- Exact recent timeline projection without the former additional 12-event and
  500-character caps. The context-engine recent-tail boundary remains separate
  from later session-history digestion.
- Pending-routing guard: normal task tools cannot run while a pending turn is
  unbound or clarifying.
- Fresh-session mutation gate: when no active task exists, read-only tools can
  run in the session run, while mutation repairs back to promotion-target
  selection or clarification instead of crashing with a missing run.
- Active context refresh after activate/create routing.
- Same-turn continuation after routing: create/activate tools return a real
  run id, routing tools are deactivated, normal work tools are prepared, and the
  agent can complete work in the same user turn.
- Provider-loop coverage for ambiguous task clarification followed by a user
  answer that activates and mutates the selected task, proving the old
  clarification run remains session-only.
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
- Prompt-facing read tool context through `context.run.toolCalls`,
  kept separate from durable task state.
- Separate run tool-call records and prompt projections. Every prompt-eligible
  call remains full below the model profile's soft limit. At pressure, a shadow
  planner proposes the minimum older-call previews or summaries needed to
  recover to the target while keeping the latest six calls and pinned failures
  full. Filesystem read/search/write, shell, test/build, and Git-context
  projectors use bounded structured execution metadata, and the complete
  alternative prompt is reserialized and measured before its receipt is
  recorded. The default policy remains shadow-only; an explicit enforcement
  policy applies the projection, remeasures the complete final request, and
  admits only that final request. Source tool records, current task context,
  and run work state remain unchanged.
- Prompt-facing harness repair feedback through `context.harness.feedback`,
  kept separate from run context.
- Filesystem inspection and efficient read tools:
  - `inspect_paths` for metadata, line counts, content hints, hashes, directory
    counts, and read recommendations.
  - `read_files` for multi-file reads.
  - `read_files` and `read_files` advisory feedback when metadata should be used
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
- Model-aware decision context measurement for 128K and larger context
  profiles. The final assembled request includes native tool schemas and repair
  messages, uses provider counting at the soft limit when available, and
  records budget and compilation receipts. The default 128K profile uses a 60K
  recovery target, 70K soft limit, and 100K hard input limit. Run-scoped state
  records pressure observations and exposes a compact pressure signal to later
  decisions. A deterministic controller resets unresolved pressure after
  successful recovery, recommends a timeline checkpoint after two unresolved
  iterations, and recommends it immediately near the admission limit. Applied
  and recommended modes remain separate. Over-limit final requests are rejected
  before provider generation.
- Deterministic timeline-checkpoint foundation: typed checkpoint events,
  structured summary schema, contiguous-prefix planning, minimum exact-tail and
  current-input protection, token-savings estimates, source hashing, and
  coverage/reference validation.
- Pressure-aware structured LLM timeline checkpoints after tool projection.
  Runtime-owned metadata, strict local validation, one repair, output and input
  token guards, run-scoped positive/negative caching, immutable combined prompt
  projection, candidate/intermediate/final measurement, and safe unchanged-source
  fallback are implemented.

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
3. App-level finalization coverage for completed, failed, blocked,
   needs-user-input, stuck/max-iteration, and tool-failure outcomes.
4. Legacy cleanup around historical focus/message-link/event files.
5. Stable milestone tags.
6. Add task-relevant session digests for pressure that remains unresolved after
   timeline checkpointing, then add reference-only step ledgers.
