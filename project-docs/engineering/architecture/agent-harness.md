# Agent Harness

Ayati uses one stable harness:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Do not introduce controller stages, graph frameworks, harness-version
switches, or a second model loop. Observation, binding proposals, execution,
repair, and validation all advance through the same primary decision loop.

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
immutable workstream/request binding. Its id never changes. Navigation state
is run-scoped: every run begins at `ENTRY`, and the next accepted input creates
a new run at `ENTRY` in the same agent stream.

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

An unbound run may enter read-only observation modes. A bound run may enter
`execute` with resource-scoped task capabilities. Mutation without binding
fails closed.

Routing controls disappear after successful binding. A recent or active
workstream is context, not implicit authority.

## Native Decision Surface

The model can:

- return normal assistant text at `ENTRY` for a genuinely tool-free request;
- call `decision_transition_mode` with an immediate purpose, exact capability
  groups, and evidence-backed targets;
- call one selected executable tool or an explicitly safe read-only batch;
- call `decision_validate` with a terminal outcome and the complete user-facing
  response after the graph is active.

The run-scoped virtual graph is:

```text
ENTRY -> observe.locate | observe.investigate | resolve | direct reply
observe.locate <-> observe.investigate -> resolve | validate
resolve -> execute | needs_user_input | failed
execute -> execute | observe.locate | observe.investigate | validate
validate -> terminal when accepted | source mode with repair when rejected
```

`resolve` and `validate` are transient harness gates, not stored modes. The
stored active mode is only `observe.locate`, `observe.investigate`, `execute`,
or none. A bound execute run may temporarily observe and return directly to
execute; it never resolves again because the run binding is immutable.

Typical traces remain inside the one harness loop:

```text
greeting:    ENTRY -> direct response
exact read:  ENTRY -> observe.investigate -> read -> validate
vague read:  ENTRY -> observe.locate -> find -> observe.investigate -> read -> validate
ambiguity:   observe.locate -> validate(needs_user_input)
mutation:    observe -> resolve -> execute -> validate
repair:      execute -> observe.investigate -> execute -> validate
```

The model never sees a separate workstream-resolution agent or lifecycle tool.
Before `resolve`, it uses read-only workstream search/read and resource-owner
lookup in an observation mode. An accepted transition to `resolve` must have
mutation-permitting intent, a binding-required capability, evidence-backed
targets, and one typed activate-or-create proposal citing exact current-run
routing evidence. The deterministic gate runs at most once, makes no model
request, and requires a fresh primary decision after authoritative bound
context is mounted.

Executable tools retain native schemas. Harness-only controls are not
persisted as fake calls. Invalid text-encoded calls and malformed schemas
receive bounded repair feedback followed by a fresh decision.

## Workstream Observation and Deterministic Binding

The primary loop owns read-only workstream routing observations. It requests
focused capability groups instead of lifecycle effects:

```text
decision_transition_mode({
  to: "observe.locate",
  purpose: "Find the durable owner of result.txt.",
  capabilities: ["workstream:search", "resource:ownership"],
  targets: ["result.txt"]
})
-> read-only routing observation step
decision_transition_mode({
  to: "resolve",
  purpose: "Bind the exact output before writing it.",
  capabilities: ["file:write"],
  targets: ["result.txt"],
  binding: { kind: "create" | "activate", ..., evidence: ["run:...:step:...:call:..."] }
})
-> deterministic binding gate (zero model calls)
-> automatic execute entry with a replaced capability surface
-> refreshed authoritative context
-> fresh main decision
```

The model-facing read-only groups are `workstream:search`, `workstream:read`,
and `resource:ownership`. Their calls are persisted as ordinary observation
steps, but their evidence is tagged as routing evidence and cannot satisfy
whole-task completion.

The gate checks mutation intent, binding-required taxonomy, exact target
provenance, current-run routing references, candidate identity, workstream
HEAD, request identity, and the one-attempt limit. For creation, it searches
again immediately before the commit and returns `needs_user_input` when a
probable or definite owner exists. For activation, it re-reads the exact
candidate and rejects a stale HEAD. Exact path or URL targets are inspected
inside the gate before they are bound.

Only after those checks does the coordinator call Context Engine's atomic
create or activate operation. The binding is immutable. The gate records a
control/evaluation event, not a task step, owns no history or WorkState, and
has no prompt, provider, reducer, context-preparation lane, token budget, or
retry loop.

`git_context_activate_workstream`, `git_context_create_workstream`, and
`git_context_inspect_resource` remain hidden lifecycle operations. The model
can observe with `git_context_find_workstreams`,
`git_context_read_workstream`, and `git_context_find_resources`; it cannot
invoke the lifecycle operations directly.

## History Controls

Older stream continuity is accessed with:

- `agent_history_search`
- `agent_history_read`

Binding uses the already prepared agent stream and run; it never allocates a
second run. Existing workstreams require an explicit continue-or-create
request decision in the proposal. After binding, the runner refreshes context
and asks for a new decision. A stale mutation call is rejected and never
stored for replay.

## Agent-Facing Context Pack

Prompt context uses explicit bounded lanes:

- `temporal`: durable checkpoint plus exact recent messages;
- `current`: exact ingress message and routing state;
- `stream`: identity and recent completed-work references;
- `work`: at most five candidates and the single selected
  workstream/request; routing evidence stays in current-run tool calls;
- `resources`: stream, ingress, and bound-work resources;
- `observations`: valid reusable inventory, discovery, and evidence;
- `personal`: independent personal-memory snapshot;
- `tools`: current capability surface;
- `harness`: compact repair feedback;
- `run`: WorkState, current calls, the compact virtual-mode card, pressure
  state, and an optional disposable anchored focus summary that is navigation
  context only.

Do not expose context-repository paths, database paths, run storage paths,
idempotency journals, observation authority fields, or deferred mutation.

## Mode-Scoped Capability Visibility

Tools have one purpose (`list`, `read`, `search`, `control`, `mutation`) and
one effect (`read_only`, `workspace_mutation`, `context_mutation`,
`external_mutation`, `destructive`). Unknown taxonomy fails closed.

At `ENTRY`, the executable working set is empty. The model sees a compact
catalog of exact capability-group identifiers plus the transition control.
The harness resolves a requested responsibility to eligible concrete tools.

`observe.locate` and `observe.investigate` expose only read-only tools. A mode
transition replaces the complete working set so tools from an earlier mode do
not accumulate. Bounded self-transitions may adjust the surface; repeated
identical transitions stop through no-progress protection. `execute` reuses
the existing bound-resource policy. Selecting a capability never authorizes
its effect; resource-scoped validation still runs at execution time.

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

After graph activation, every terminal outcome uses
`decision_validate({ outcome, summary, response, resources? })`. The request
carries the final user response, so accepted validation needs no extra model
call. Observation validation checks verified read evidence. Execute validation
reuses deterministic completion policy: remaining work/blockers, current-run
task-step evidence, resource access, containment, existence, exact artifact
evidence, and unresolved failures. Workstream-routing observations can guide
binding but can never satisfy task-completion evidence. Rejected validation
preserves the source mode and WorkState and returns bounded typed repair
feedback.

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
tool-free ENTRY reply          -> done / completed
accepted completed validation  -> done / completed
accepted needs-input validation -> needs_user_input / needs_user_input
accepted blocked validation    -> blocked / blocked
accepted failed validation     -> failed / failed
iteration budget               -> incomplete / run_limit
context admission budget       -> incomplete / context_limit
safe crash recovery            -> incomplete / interrupted
```

## Context Pressure

Admission measures the complete serialized provider request, including system
messages and exact native tool schemas. A pre-serialization manifest records
`system`, `session`, and `work` lane estimates. Their 15%/25%/60% shares are
planning targets over the hard input budget, not reservations: unused capacity
is borrowed and whole-request admission remains authoritative.

For the default 128K profile, preparation starts at 55K, recovery targets 60K,
soft pressure starts at 70K, hard input is 100K, and output reserve is 8,192.
A 15K preparation lead also starts work when predicted growth would cross the
soft threshold. One low-priority semantic preparation call may overlap a
foreground call on the same provider. The candidate remains in memory and
foreground work does not wait below the forced barrier.

Recovery order is:

1. remove stable duplicates and invalid/expired observations;
2. replace recoverable older output with typed previews and refs;
3. deterministically bound candidates, recent work, resources, and
   observations while preserving failures and the six-call hot window;
4. adopt a durable checkpoint candidate over complete terminal runs;
5. if still needed, adopt a run-scoped anchored focus summary;
6. rebuild and remeasure the whole request.

The next-decision reserve is `max(8K, soft - recovery)`. The forced barrier is
the active admission limit minus that reserve: 85K for the conservative 95K
local admission limit or 90K after an exact provider count permits the 100K
hard limit. At the barrier, the foreground waits once for a relevant candidate
and then performs synchronous deterministic/semantic recovery. A request is
never sent beyond its admission limit.

Checkpoint generation uses a structured schema, exact message-sequence
anchors, a 1,200-token default estimate, and at most one repair. Generation is
read-only; commit and active-pointer update occur only at validated adoption.
A temporary focus summary is limited to 1,600 estimated tokens and one repair,
must anchor every statement, cannot replace current input, authority,
WorkState, unresolved failures, or completion evidence, and disappears at run
finalization/interruption/restart. If the final candidate is still unsafe, the
run ends as `incomplete/context_limit`.

The existing projection policy remains operational: `shadow` prepares,
validates, and measures candidates without mounting or committing them;
`enforce` adopts valid candidates and activates forced-barrier behavior.
Decision repairs reuse the active projection without starting background
jobs. Final-response generation may reuse it and run deterministic safety
recovery but starts no new semantic work.

## Feedback and Recovery

Feedback tracing records compact decision, action, verification, routing,
step, observation, checkpoint, resource, finalization, and transport events.
Navigation feedback separately counts transitions, the single deterministic
binding attempt, validation acceptance/rejection, foreground model work, and
background summary work. Event capture and report generation are queued off
the execution path; repair feedback required by the next decision remains
synchronous. Zero-step unbound and read-only unbound runs are healthy.

Startup resumes journaled operations idempotently and never discards verified
dirty resource changes. Unsafe ambiguity moves the run to
`recovery_required` and blocks the agent stream until resolved.
An unpublished mutation preparation with no tool or resource evidence is a
safe no-effect interruption: startup releases its lease before normal run
interruption recovery. Published authority still fails closed.

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
