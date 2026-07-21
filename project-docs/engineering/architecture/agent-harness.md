# Agent Harness

Ayati uses one stable harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Do not introduce controller stages, graph frameworks, harness-version
switches, or a second authoritative task-execution loop. A bounded isolated
control activity may reuse the decision/tool/verification shape when it owns
separate state and returns a typed result to the coordinator.

## One Run Per Accepted Input

Every accepted user message or system event atomically appends one immutable
stream message and creates exactly one run. A run is the compute, audit,
idempotency, finalization, and recovery boundary. Direct replies are valid
zero-step runs.

```text
message/event
-> prepare agent stream message + run + WorkState
-> project stream continuity and run context
-> decide / act / verify / reduce / persist step (zero or more)
-> finalize run + append assistant message
-> send terminal acknowledgement
```

A run may remain unbound for conversation and observation or gain one
immutable workstream/request binding. Its id never changes. The next accepted
input creates a new run in the same agent stream.

## Agent Stream Versus Run Context

The stream grows slowly across runs: discussion messages, a durable pressure
checkpoint, an exact recent tail, recent-work references, resources, and
reusable list/search/read observations.

The run grows quickly: WorkState, ordered steps, tool calls, verification,
evidence, and pressure state. Action history does not become a stream lane.
Only reduced work/resource facts and explicit evidence references survive.

## Binding Is Not Mutation Authority

Workstream binding establishes durable ownership. Resource access establishes
what may be read or changed. Exact mutation preparation and verification
establish authority for one operation.

An unbound run may use list, read, search, and permitted control capabilities.
A bound run receives workstream feedback/completion controls and resource-
scoped task capabilities. Mutation without binding fails closed.

Routing controls disappear after successful binding. A recent or active
workstream is context, not implicit authority.

## Native Decision Surface

The model can:

- return normal assistant text;
- call `workstream_resolve` once for actionable work on an eligible unbound
  run;
- call `decision_load_tools`;
- call one selected executable tool or an explicitly safe read-only batch;
- call `ask_user_feedback` during an active bound run;
- call `workstream_completion` after normal work is verified.

Executable tools retain native schemas. Harness-only controls are not
persisted as fake calls. Invalid text-encoded calls and malformed schemas
receive bounded repair feedback followed by a fresh decision.

## Isolated Workstream Resolution

The main loop never calls workstream discovery, ownership inspection,
activation, or creation tools directly. It calls:

```text
workstream_resolve({ purpose, hints })
```

The coordinator waits synchronously while a bounded resolver activity runs
with its own context snapshot, state, history, tool budget, and usage
accounting. The resolver receives the current input, at most two prior
messages, ingress resources, at most five initial candidates, and any prior
ambiguity packet. It does not receive or reduce main WorkState.

Its fixed private catalog contains search, candidate read, resource-owner
lookup, resource inspection, activate, create, and clarification operations.
Up to four independent search/read/owner calls may run in parallel. Version 1
allows six model turns, sixteen private calls, and two failed steps. Every
decision, call, result, verification, state transition, and usage record is
written to the resolver journal, not `run_steps`.

The resolver ends with exactly one typed result:

- bind one existing workstream and continue or create one request;
- create one workstream with one accurate initial request;
- publish a compact ambiguity packet; or
- fail safely.

The Context Engine commits the binding and publishes a new projection before
the coordinator returns a metadata receipt. The main loop then makes a fresh
decision against the mounted context. It never receives the resolver's full
history as tool output. Only the coordinator reduces authoritative run and
WorkState; all Context Engine writes still pass through its single serialized
in-process owner.

The resolver's private tools must not be registered in the main working set.
Legacy `git_context_find_workstreams`, `git_context_read_workstream`,
`git_context_inspect_resource`, `git_context_activate_workstream`, and
`git_context_create_workstream` calls fail closed in the main loop.

## History Controls

Older stream continuity is accessed with:

- `agent_history_search`
- `agent_history_read`

Resolution uses the already prepared agent stream and run; it never allocates
a second run. Existing workstreams require an explicit continue-or-create
request decision. After binding, the runner refreshes context and asks for a
new decision. A stale mutation call is rejected and never stored for replay.

## Agent-Facing Context Pack

Prompt context uses explicit bounded lanes:

- `temporal`: durable checkpoint plus exact recent messages;
- `current`: exact ingress message and routing state;
- `stream`: identity and recent completed-work references;
- `work`: at most five candidates, the resolver result, and the single
  selected workstream/request;
- `resources`: stream, ingress, and bound-work resources;
- `observations`: valid reusable inventory, discovery, and evidence;
- `personal`: independent personal-memory snapshot;
- `tools`: current capability surface;
- `harness`: compact repair feedback;
- `run`: WorkState, current calls, and pressure state.

Do not expose context-repository paths, database paths, run storage paths,
idempotency journals, observation authority fields, or deferred mutation.

## Tool Loading and Visibility

Tools have one purpose (`list`, `read`, `search`, `control`, `mutation`) and
one effect (`read_only`, `workspace_mutation`, `context_mutation`,
`external_mutation`, `destructive`). Unknown taxonomy fails closed.

The working set is small and run-scoped. Loading a tool does not authorize its
effect. Resource-scoped validation still runs at execution time.

## Action Execution and Verification

The action executor:

1. validates action and input schemas;
2. resolves capability and resource policy;
3. prepares exact mutation observations when needed;
4. executes the call;
5. normalizes the result;
6. runs deterministic contracts and assertions;
7. verifies resource effects;
8. extracts grounded facts and artifacts.

Parallel mutation is denied by default. Tool transport success is not proof of
outcome. Only verified facts and evidence reach the progress reducer.

## WorkState and Step Persistence

WorkState is the sparse current-run aggregate: status, summary, open work,
blockers, verified facts, evidence, artifacts, next step, and optional user-
input need. The deterministic reducer owns its evolution.

Every executor step is persisted through `recordRunStep` with contiguous step
number, decision/action, complete ordered calls, deterministic verification,
and WorkState after the step. The same service operation returns the updated
authoritative projection used by the next decision. Replay is idempotent;
gaps, conflicting duplicates, terminal-run steps, unknown effects, and unbound
mutations fail.

Successful read-only list/search/read calls may create reusable observations.
Mutations and control calls never do.

## Completion and Finalization

`workstream_completion({ summary, resources })` is available only when bound.
It is a typed intent, not a second agent loop. Deterministic completion policy
checks remaining work/blockers, current-run task-step evidence, resource
access, containment, existence, exact artifact evidence, and unresolved
failures. Resolver journal entries can never satisfy completion evidence.

One coordinator serves chat and system events. `finalizeRun` receives outcome,
stop reason, assistant response, summaries, validation, WorkState, and optional
completion. It atomically appends the assistant message and closes the run,
then returns independent resource effects and workstream-context commit facts.

Response ordering is strict:

1. stream model text deltas if supported;
2. finalize and await durable acknowledgement;
3. send the terminal envelope with truthful context-commit state;
4. accept client render acknowledgement.

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

## Context Pressure

Admission measures the whole provider candidate. Recovery order is:

1. optional tool-result compaction;
2. deterministic bounded stream projection;
3. pressure-only durable checkpoint over complete terminal runs;
4. rebuild and remeasure checkpoint plus exact tail.

Checkpoint generation uses a structured schema, exact message-sequence
anchors, a 1,200-token default estimate, and at most one repair. Commit and
active-pointer update are atomic. If the final candidate is still unsafe, the
run ends as `incomplete/context_limit`.

## Feedback and Recovery

Feedback tracing records compact decision, action, verification, routing,
step, observation, checkpoint, resource, finalization, and transport events.
Zero-step unbound and read-only unbound runs are healthy.

Startup resumes journaled operations idempotently and never discards verified
dirty resource changes. Unsafe ambiguity moves the run to
`recovery_required` and blocks the agent stream until resolved.

## Do Not Reintroduce

- daily context sessions or rollover;
- conversation segments or transcript materialization;
- session-run versus work-run classes;
- lazy or secondary run creation;
- reusable action context;
- implicit ownership from recent work;
- project files inside workstream context Git;
- mutation authority inferred from binding alone;
- deferred mutation storage/replay;
- model-owned context Git writes;
- compatibility aliases for removed V5 lifecycle APIs;
- acknowledgement before durable finalization.
