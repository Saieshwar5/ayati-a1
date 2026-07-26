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
-> prepare agent stream message + attachment links + run + WorkState
-> project stream continuity and run context
-> decide / act / verify / reduce / persist step (zero or more)
-> finalize run + append assistant message with response semantics
-> send terminal acknowledgement
```

A run may remain unbound for conversation and observation or gain one
immutable workstream/request binding. Its id never changes. Navigation state
is run-scoped: every run begins at `ENTRY`, and the next accepted input creates
a new run at `ENTRY` in the same agent stream.

Stream sequence numbers provide exact chronology across those runs. They are
not treated as an automatic question/answer edge: a later user message may
answer, revise, combine, postpone, or ignore an earlier assistant feedback
question. Durable assistant response/feedback kinds and per-user-message
attachment references give the next decision enough exact structure to
interpret short replies without imposing a brittle pending-interaction state.

## Agent Stream Versus Run Context

The stream grows slowly across runs: discussion messages, a durable continuity
checkpoint, an exact recent tail, recent-work references, and resources.

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

- return normal assistant text at `ENTRY` for conversation, supplied-content
  transformation, or a focused clarification before graph entry;
- use one of the five active-document paths already visible in the Core
  Capsule to enter read-only investigation without rediscovering that path;
- enter transient `context.retrieve`, load relevant advertised Hot Context,
  and return automatically to the preceding mode;
- call one graph-legal destination-specific mode control with an immediate
  purpose, exact capability ids, and typed search subjects, read-only
  references, or mutation scopes;
- call one selected executable tool or an explicitly safe read-only batch;
- call `decision_stop` only for a supported `needs_user_input`, `blocked`, or
  `failed` outcome;
- return normal assistant text after the stored `validation` mode has passed.

The run-scoped virtual graph is:

```text
ENTRY -> context.retrieve | observe.locate | observe.investigate | resolve | direct reply
observe.locate <-> observe.investigate -> context.retrieve | resolve | validation
resolve --accepted--> execute
execute -> context.retrieve | execute | observe.locate | observe.investigate | validation
context.retrieve --after context_load--> preceding mode
validation(failed) -> work mode | stop
validation(passed) -> direct reply
```

`resolve` is a transient deterministic gate. `validation` is a real stored,
proof-only mode so its small checklist and result remain visible across
decisions. `context.retrieve` is a transient stored detour: it exposes only
bounded context-loading tools, never compacts context, and restores the
preceding mode after the load. The other stored modes are `observe.locate`,
`observe.investigate`, and `execute`. A bound execute run may temporarily
observe and return directly to execute; it never resolves again because the
run binding is immutable.

Transition inputs are discriminated by destination. `observe.locate` accepts
non-authoritative `subjects`; investigation uses typed read-only `references`;
resolve and execute use typed `mutationScopes`; unbound resolve also requires
a typed binding proposal. Host filesystem values are canonical absolute paths.
Portable children inside a named resource use `relativePath` and are never
resolved from process cwd.

Typical traces remain inside the one harness loop:

```text
greeting:    ENTRY -> direct response
clarify:     ENTRY -> direct clarification
preference:  ENTRY -> context.retrieve -> context_load -> ENTRY -> direct response
exact read:  ENTRY -> observe.investigate -> read -> validation(proof) -> direct response
vague read:  ENTRY -> observe.locate -> find -> observe.investigate -> read -> validation(proof) -> direct response
ambiguity:   observe.locate -> resolve(ambiguous) -> decision_stop(needs_user_input)
mutation:    observe -> resolve -> execute -> validation(proof) -> direct response
repair:      execute -> validation(failed) -> execute -> validation -> direct response
```

The model never sees a separate workstream-resolution agent or lifecycle tool.
Before `resolve`, it uses read-only workstream search/read and resource-owner
lookup in an observation mode. An accepted transition to `resolve` must have
mutation-permitting intent, a binding-required capability, evidence-backed
mutation scopes, and one typed activate-or-create proposal citing exact current-run
routing evidence. The deterministic gate performs at most one lifecycle
binding attempt, makes no model request, and requires a fresh primary decision
after authoritative bound context is mounted.

Executable tools retain native schemas. Harness-only controls are not
persisted as fake calls. Invalid text-encoded calls and malformed schemas
receive bounded repair feedback followed by a fresh decision.

## Workstream Observation and Deterministic Binding

The primary loop owns read-only workstream routing observations. It requests
focused capability ids instead of lifecycle effects:

```text
decision_enter_observe_locate({
  purpose: "Find the durable owner of result.txt.",
  capabilities: ["workstream:search", "resource:ownership"],
  subjects: ["result.txt"]
})
-> read-only routing observation step
decision_resolve_create({
  purpose: "Bind the exact output before writing it.",
  capabilities: ["file:write"],
  mutationScopes: [{ kind: "filesystem", value: "/absolute/project/result.txt" }],
  binding: { kind: "create", ..., evidence: ["run:...:step:...:call:..."] }
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
probable or definite owner exists, unless the user explicitly selected a new
independent workstream. An exact follow-up answer to that durable question is
recognized on the next run. Ambiguity performs no binding and does not consume
the attempt. For activation, the gate re-reads the exact candidate and rejects
a stale HEAD.

Read-only references are never inspected or bound as mutation resources.
Filesystem mutation scopes and exact resource ids are rechecked inside the
gate before binding. Directory scopes authorize canonical descendants, not
siblings or symbolic-link escapes.

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

- `core`: one exact current input and routing state plus a strict-budget
  checkpoint, whole recent exact turns, and explicit unloaded ranges;
- `hot`: metadata for optional typed context plus bounded run-scoped entries
  mounted through `context.retrieve`, including recent-file navigation that
  can ground an exact read-only investigation path but never authority;
- `tools`: current capability surface;
- `harness`: compact unresolved repair feedback;
- `run`: WorkState, current calls, a compact `verifiedOutcomes` catalog, the
  virtual-mode card, pressure state, and an optional disposable anchored focus
  summary that is navigation context only. Tool calls retain useful inputs,
  outputs, purposes, execution status, and one verification-status scalar;
  detailed verification records and completion evidence remain internal.
  Validation status and its exact checklist appear in the mode card; the model
  selects kind and subject from `verifiedOutcomes` instead of copying
  tool-call evidence into a completion transaction.

Current workstream details and resource cards are not prompt lanes or Hot
Context entries. The agent obtains current ownership and resource facts
through read-only routing/resource tools. Routing evidence stays in
current-run tool calls, and resource enforcement continues to use exact
Context Engine state.

Do not expose context-repository paths, database paths, run storage paths,
idempotency journals, observation authority fields, or deferred mutation.

## Mode-Scoped Capability Visibility

Tools have one purpose (`list`, `read`, `search`, `control`, `mutation`) and
one effect (`read_only`, `workspace_mutation`, `context_mutation`,
`external_mutation`, `destructive`). Unknown taxonomy fails closed.

At `ENTRY`, the executable capability surface is empty. The model sees a
compact catalog of exact capability identifiers plus the transition control.
The native schema exposes only graph-legal destinations and capabilities
available under current authority. The harness resolves each requested
responsibility to eligible concrete tools.

`observe.locate` and `observe.investigate` expose only read-only tools. A mode
transition replaces the complete capability surface so tools from an earlier mode do
not accumulate. Bounded self-transitions may adjust the surface; repeated
identical transitions stop through no-progress protection. `execute` reuses
the existing bound-resource policy. Selecting a capability never authorizes
its effect; resource-scoped validation still runs at execution time.

`context.retrieve` exposes only `context_load` through `context:load`. Its
receipt is audited, but full content is mounted directly in
`context.hot.loaded`; it does not become WorkState or a durable work step.

One transition may select one to three capabilities. Every core tool for an
accepted capability must fit the surface; core coverage is never silently
truncated. Optional tools may be omitted only with an explicit receipt. See
[Capability Catalog and Tool Surfaces](capability-surfaces.md).

`validation` is intentionally smaller than the other modes. Its only
capability is `task:validation`, which is a proof-only capability with no
executable tools. The runtime evaluates compact current-run completion
evidence that earlier deterministically verified calls already produced.
Investigation tools, mutation tools, routing tools, and prior mode tools are
not carried into it.

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
outcome. Verified facts and evidence reach the run-local progress reducer and
verification index; routine action execution does not update WorkState. After
the final checklist passes, the terminal runtime may promote only the selected
passed outcomes into a few compact WorkState completion receipts.

This per-action verification answers: “Did this tool call execute safely and
produce the result it claims?” Verified calls emit compact completion data:
filesystem path/read evidence, registered semantic facts, non-filesystem
artifact identities, or an exact deterministic call receipt when no stronger
typed outcome exists. Validation does not re-run or re-verify those actions.
It answers the separate, smaller question: “Do the few required verified
outcomes already prove the responsibility the agent is about to report as
finished?”

Verification is owned by each exact `runId`/step/`callId`, even when a step
contains sequential or parallel calls. Each persisted call carries one
normalized `passed`, `failed`, or `not_available` verification record. Step
verification is derived from the collection: deterministic step validation
passes only when every required executed call has its own passed record.

Before whole-task validation, the runtime deterministically rebuilds one
current-run verified-outcomes index from those persisted call records. The
index contains compact call receipts, normalized completion and supporting
outcomes, failed or unavailable verification states, exact call references,
and invalidated filesystem proofs. It is a derived in-memory query surface,
not another database or evidence owner. Cross-run records are rejected,
routing outcomes remain navigation-only, and a later exact or ancestor
mutation invalidates an earlier read or path proof.

The model sees only the index's currently valid completion subset under
`context.run.verifiedOutcomes`. Each entry contains a validation-ready kind,
subject, relevant path kind, search scope, or read scope, and its
step/call/tool source.
Supporting facts, routing outcomes, invalidated proof, hashes, verification
contracts, checks, and methods stay internal. The adjacent tool-call
projection keeps its exact normal input and output; moving proof detail out of
that projection is not tool-input or tool-output compaction.

## WorkState and Step Persistence

WorkState is the small durable face of a run. It contains only:

- status and a concise progress summary;
- an optional flat implementation plan, created only for genuinely complex
  work;
- essential artifacts, decisions, findings, and constraints;
- one next action.

Routine executor steps never revise WorkState. `recordRunStep` persists the
contiguous step, complete ordered calls, and deterministic verification while
leaving the current WorkState revision unchanged. Tool truth therefore has one
owner: the run journal and its derived verification index.

The model can call `decision_checkpoint_workstate` after the virtual graph is
active. A `plan` checkpoint creates or materially updates the optional plan. A
`context_pressure` checkpoint records a safe continuation handoff before old
model-facing tool context is compacted. The Context Engine persists each
checkpoint with an expected revision and exact `afterStep`, so stale or
out-of-order updates fail.

Successful finalization writes the terminal `run_completed` state. A truthful
pause or failure writes `run_paused`. When a later run explicitly continues
the same active workstream request, its material prior WorkState is restored
as an `in_progress` `continuation` state. An untouched initial WorkState is
omitted from the model-facing prompt; material WorkState is projected with
compact active-workstream metadata.

Immediately before a successful terminal state is built, the runtime converts
at most four passed final-validation checks into `importantContext` receipts.
Each receipt contains only a compact outcome description and its exact
run/step/call proof reference. Complete reads identify complete coverage;
bounded reads preserve the validated slice, search, or profile scope;
durable write/artifact outcomes are classified as artifacts. Failed checks,
raw verification contracts, hashes, tool payloads, and supporting outcomes are
never copied. Existing important context is retained within the overall
twelve-item WorkState bound.

Successful calls remain exact in the run step journal with their inputs,
outputs, hashes, classifications, and deterministic verification. Step
persistence does not create a second cross-run observation record. When older
evidence is needed, bounded history search reads the authoritative run journal
on demand and returns an exact run/step/call reference.

## Completion and Finalization

When the derived verification index indicates that the current responsibility
may be fulfilled, the model enters `validation` with one to twelve important
typed outcome checks:

```text
decision_enter_validation({
  purpose: "Verify the important site outputs before responding.",
  capabilities: ["task:validation"],
  validationChecks: [
    { kind: "path.exists", subject: "/absolute/site/index.html", expectedKind: "file" },
    { kind: "process.exit_success", subject: "pnpm test" }
  ]
})
```

`path.exists` requires a verified current-run path-state result for the exact
subject and optional expected kind. `file.read_complete` requires a verified
current-run
`read_files` result whose explicit coverage is `complete`, whose content was
returned, and which has not been invalidated by a later mutation. Search
matches, profiles, samples, partial slices, failed verification, and
historical-run evidence do not satisfy it.

When the responsibility asks for a bounded read instead of the whole file,
`file.read_scope_satisfied` carries one exact `readScope`:

```text
{
  kind: "file.read_scope_satisfied",
  subject: "/absolute/src/parser.ts",
  expectedKind: "file",
  readScope: { mode: "slice", startLine: 100, endLine: 120 }
}
```

An untruncated verified slice satisfies the check when its returned line range
covers the required range. Exact untruncated search and profile reads use
`{ mode: "search", query: "..." }` and `{ mode: "profile" }`. A complete read
is stronger and may satisfy any bounded scope for the same file. Truncated
scopes, automatic samples, narrower slices, and different search queries
remain supporting evidence and do not pass. Later file mutation invalidates
both complete and bounded read proof.

A conclusive zero-result `find_files` call produces
`file.search_no_match`. Its exact `searchScope` records the canonical roots,
depth, and hidden-file policy. The outcome exists only when traversal was
uncapped, error-free, and did not skip a directory at the depth limit. A later
filesystem mutation inside a searched root invalidates the negative proof.
Incomplete zero-result searches cannot prove that a target is absent.

Registered semantic kinds cover calculator, database, Pulse, process, Python,
memory, and managed-artifact outcomes. `tool.call_succeeded` is an exact-call
fallback keyed by `callId`; it is emitted only by the existing deterministic
runtime verifier when no stronger completion outcome exists. Routing calls
never produce task-completion proof.

Entering validation queries only the relevant outcomes in the derived
current-run index and records the satisfying exact call reference on each
passed check. It does not call
`inspect_paths`, `read_files`, `process_run`, or any other action tool. If
proof is missing, wrong-kind, stale, or incomplete, the stored check fails with
a direct repair reason. The agent returns to the appropriate work mode and
performs only the missing operation once.

A passed checklist unlocks a direct final response only when WorkState has no
remaining work, blocker, user-input need, or unresolved current-run failure. A
failed checklist keeps the virtual graph active. The agent returns to locate,
investigate, or bound execute, repairs the issue, and enters validation again.
On an accepted final response, the runtime—not the model—derives the bounded
completion receipts from the stored passed checklist, marks WorkState done,
uses the response as its summary, and removes the next action.
Generated deliverables committed during finalization are derived from
the intersection of passed filesystem validation subjects and artifacts
actually produced by successful mutation steps; the model does not declare
completion resources.

`decision_stop` handles only non-successful terminal outcomes. It requires a
specific supported question for `needs_user_input` or a current blocker/failure
for `blocked` and `failed`. Successful work never uses `decision_stop`.

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
ENTRY direct reply             -> done / completed
passed validation + direct reply -> done / completed
accepted needs-input stop      -> needs_user_input / needs_user_input
accepted blocked stop          -> blocked / blocked
accepted failed stop           -> failed / failed
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

The 4K Core Capsule continuity budget is independent of these whole-request
thresholds. When older whole turns do not fit, the prompt remains bounded
immediately and names the unloaded exact sequence range. The runtime may
synchronously adopt a beneficial durable checkpoint before the first decision
even when the complete prompt is far below 55K.

Recovery order is:

1. remove stable duplicate projections;
2. replace recoverable older output with typed previews and refs;
3. deterministically bound candidates and resources while preserving failures
   and the six-call hot window;
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

Repair records remain in run history after recovery, but only unresolved
repairs are projected into later model prompts or used by repeat-failure
guards. Accepted mode transitions, authoritative binding, verified actions,
and accepted validation resolve the matching repair scope and emit a
`repair_resolved` feedback event. WorkState, tool evidence, and deterministic
verification remain authoritative; resolving prompt feedback does not erase
them.

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
