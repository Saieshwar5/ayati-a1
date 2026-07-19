# Agent Harness

Ayati uses one stable harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Do not introduce controller stages, graph frameworks, harness-version
switches, or a second execution loop.

## One Run

Every accepted user message or system event atomically creates exactly one
run. A run is the compute, audit, idempotency, finalization, and recovery
boundary. Direct replies are valid zero-step runs.

```text
message/event
-> prepare message + conversation + run + WorkState
-> build context
-> decide / act / verify / reduce / persist step (zero or more)
-> finalize
-> send terminal acknowledgement
```

A run can remain unbound for conversation and observation or gain one immutable
workstream/request binding. Its id never changes. A completed run cannot switch
or reopen; the next accepted input creates a new run.

## Binding Is Not Mutation Authority

Workstream binding establishes durable ownership. Resource access establishes
what may be read or changed. Exact resource-mutation preparation and
verification establish authority for one mutation operation.

An unbound run may use list, read, search, and permitted control capabilities.
A bound run receives workstream feedback/completion controls and resource-
scoped task capabilities. Mutation without binding fails closed with a stable
repair code.

Routing controls disappear after successful binding. Clearly conversational
input suppresses routing controls. A recent or active workstream is context,
not implicit authority.

## Native Decision Surface

The model can:

- return normal assistant text;
- call `decision_load_tools`;
- call one selected executable tool;
- call `ask_user_feedback` during an active bound run;
- call `workstream_completion` after normal work is verified.

Executable tools retain their own native schemas. Harness-only controls are
not persisted as fake executable calls. Successful and failed workstream
routing calls are real control steps because they change durable context.

The model must not write tool-call JSON as assistant text or embed completion
metadata inside unrelated tool inputs. Stable repair signals are fed into a
fresh decision.

## Workstream Routing

The public controls are:

- `git_context_find_workstreams`
- `git_context_read_workstream`
- `git_context_create_workstream`
- `git_context_activate_workstream`
- `git_context_set_workstream_star`
- `git_context_inspect_resource`
- `git_context_bind_resources`

Creating or activating uses the current `sessionId`, `conversationId`, and
`runId`. Existing workstreams require an explicit continue-or-create request
decision. The response returns the unchanged run id, request facts,
context-repository facts, resource bindings, and refreshed harness context.

After binding, the runner refreshes its state and asks the model for a new
decision. A stale mutation call is rejected as
`R_MUTATION_REQUIRES_WORKSTREAM_BINDING`; it is never stored for replay.

## Context Pack

Prompt context is structured and bounded:

- exact current input and recent session conversation;
- explained workstream candidates and ingress resources;
- selected workstream, request, and public resource locators when bound;
- personal/episodic recall;
- reusable `inventory`, `discovery`, `evidence`, and `actions` context;
- `context.run = { workState, toolCalls, contextPressure }`;
- selected tool schemas and compact repair feedback.

Do not expose context-repository paths, database paths, run storage paths,
runtime mode names, routing counters, duplicate top-level run state, or
deferred mutation.

Current-run calls are not duplicated in reusable read context. Reusable entries
derive from persisted structured steps and reset only after a newly created
workstream-context commit.

## Tool Loading and Visibility

Tools have one purpose (`list`, `read`, `search`, `control`, `mutation`) and
one runtime effect (`read_only`, `workspace_mutation`, `context_mutation`,
`external_mutation`, `destructive`). Unknown taxonomy fails closed.

The working set is small, run-scoped, and derived from input, binding,
resources, previous decisions, deterministic follow-up hints, and pressure.
Loading a tool does not authorize its effect. Resource-scoped validation still
runs at execution time.

## Action Execution

One decision may contain one call or an explicitly safe read-only parallel
batch. The action executor:

1. validates action and input schemas;
2. resolves capability and resource policy;
3. prepares exact mutation observations when needed;
4. executes the call;
5. normalizes the result;
6. runs deterministic tool contracts and assertions;
7. verifies resource effects;
8. extracts grounded facts and artifacts.

Parallel mutation is denied by default. Process, Python, database, and
filesystem calls must declare paths/targets needed for resource authorization.

## Deterministic Verification

Tool transport success is not proof of outcome. Contracts validate output
shape, status, counts, hashes, path existence, process exits, database effects,
and other tool-specific facts. Resource mutations additionally compare
authoritative pre/post observations.

Only verified facts and evidence reach the progress reducer. Failed validation
keeps the work incomplete even when the underlying tool returned success.

## WorkState and Progress

WorkState is the sparse current-run aggregate:

- status;
- compact summary;
- open work;
- blockers;
- verified facts;
- evidence;
- optional user-input need.

The reducer is deterministic. Tool calls do not predict whole-workstream
completion and do not directly edit durable workstream context.

## Step Persistence

Every executor step is persisted through `recordRunStep` as one versioned
record containing:

- contiguous step number and status;
- summary, decision, and action;
- complete ordered tool calls with purpose, effect, status, input, output or
  hash, and error;
- deterministic verification;
- WorkState after the step.

The same transaction updates WorkState and run step count. Replay of the same
run/step is idempotent; gaps, duplicates with different content, terminal-run
steps, unknown effects, and unbound mutations are rejected.

The response includes the updated run projection and reusable read context so
the daemon can patch its cache without a full context request.

## Completion

`workstream_completion({ summary, resources })` is available only when bound.
Each declared output identifies a bound resource and a portable relative path,
kind, description, and aliases. Deterministic completion policy checks resource
access, containment, existence, verified evidence, and unresolved failures.

A bound `done` outcome requires accepted completion evidence. Incomplete,
failed, blocked, and needs-user-input outcomes still carry an unaccepted
completion record for truthful durable reduction.

The final user response is separate from the completion control. It may stream,
but the terminal envelope waits for finalization.

## Outcome Mapping

```text
normal direct reply            -> done / completed
accepted completion            -> done / completed
focused clarification          -> needs_user_input / needs_user_input
proven blocker                 -> blocked / blocked
unrecoverable provider/tool    -> failed / failed
iteration budget               -> incomplete / run_limit
context admission budget       -> incomplete / context_limit
safe crash recovery            -> incomplete / interrupted
```

## Finalization

One runtime coordinator serves chat and system events. It submits one
`finalizeRun` request containing outcome, stop reason, canonical assistant
response, summaries, validation, WorkState, and optional workstream completion.
The service loads binding from the run.

Finalization returns independent operational facts:

- conversation/run persistence;
- optional unbound evidence materialization;
- verified resource effects;
- optional workstream-context commit (`not_required`, `no_change`, or
  `committed`).

Deliverables are never staged in context Git. Finalization reduces only
workstream/request/resource metadata and creates at most one context commit.

Response ordering is strict:

1. stream model text deltas if supported;
2. finalize;
3. await durable acknowledgement;
4. send terminal envelope with truthful context-commit state;
5. accept client render acknowledgement.

Finalization failure produces a failure terminal state and preserves recovery
data. It must never report `committed` optimistically.

## Context Pressure

Admission uses configured model limits and deterministic token measurement.
Pressure trims older summaries, reusable entries, and lower-value history
before exact current input, current ownership/resources, WorkState, and recent
steps. If safe context still does not fit, finalize with
`incomplete/context_limit`.

## Feedback and Triage

Feedback tracing is opt-in. The ledger records compact decision, action,
verification, routing, persistence, resource, finalization, and transport
events. Operator summaries expose run outcome, stop reason, binding, request
decision, context repository, resource count, HEADs, materialization,
verification, and context-commit state.

Core lifecycle events include:

- `run_started`
- `run_workstream_bound`
- `run_step_persisted`
- `resource_mutation_prepared`
- `resource_mutation_verified`
- `run_finalization_started`
- `run_finalization_completed`
- `run_finalization_failed`
- `workstream_context_commit_created`

Zero-step unbound and read-only unbound runs are healthy. A verified mutation
without corresponding verified resource effects or truthful finalization is a
failure/recovery condition.

## Failure and Recovery

Repairs are bounded. Repeated provider empties, invalid native responses,
failed verification, no progress, or routing failures end with truthful status
instead of infinite loops.

Startup resumes journaled operations idempotently. It never discards verified
dirty resource changes. Unsafe ambiguity moves the run to
`recovery_required` and blocks the session until resolved.

## Do Not Reintroduce

- session-run versus work-run classes;
- lazy or secondary run creation;
- implicit ownership from recent work;
- project files inside workstream context Git;
- mutation authority inferred from binding alone;
- deferred mutation storage/replay;
- model-owned Git commits or workstream context writes;
- compatibility aliases for removed lifecycle APIs;
- background successful acknowledgement before finalization.
