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
- use an exact absolute file path from current or recent exact context to enter
  `file:read` investigation without rediscovering or pre-inspecting that path;
- use one of the five active-document paths already visible in the Core
  Capsule as a compact navigation pointer for the same direct-read flow;
- enter transient `context.retrieve`, load relevant advertised Hot Context,
  and return automatically to the preceding mode;
- call one graph-legal destination-specific mode control with an immediate
  purpose, exact capability ids, and typed search subjects, read-only
  references, or mutation scopes;
- call one selected executable tool or an explicitly safe read-only batch;
- call `decision_stop` only for a supported `needs_user_input`, `blocked`, or
  `failed` outcome;
- return normal assistant text after the stored `validation` mode has passed.

Provider tool choice follows the same graph contract. At `ENTRY` and after
passed validation, `normal_reply` is legal and provider tool choice remains
`auto`. While the graph is active and `normal_reply` is absent from
`context.run.mode.allowedNext`, provider tool choice is `required`. If a
text-encoded tool attempt identifies one still-exposed native tool, the
bounded repair request pins that exact tool. Assistant text is never promoted
into an executable call.

The run-scoped virtual graph is:

```text
ENTRY -> context.retrieve | observe.locate | observe.investigate | workstream.route(exact focus) | direct reply
observe.locate <-> observe.investigate -> context.retrieve | workstream.route(after routing evidence) | validation
workstream.route -> context.retrieve | observe.locate | observe.investigate | resolve(after routing evidence)
resolve --accepted--> execute
execute -> context.retrieve | execute | observe.locate | observe.investigate | validation
context.retrieve --after context_load--> preceding mode
[continuity budget] -> context.maintain --after checkpoint attempt--> preceding mode
[whole-request soft pressure] -> run.maintain --after WorkState + projection--> preceding mode
validation(failed) -> work mode | stop
validation(passed) -> direct reply
```

`resolve` is a transient deterministic gate. `validation` is a real stored,
proof-only mode so its small checklist and result remain visible across
decisions. `context.retrieve` is a transient stored detour: it exposes only
bounded context-loading tools, never compacts context, and restores the
preceding mode after the load. `context.maintain` is a runtime-only detour:
the model cannot select it, it exposes no task tools or normal reply, and it
restores the complete preceding task-mode state whether checkpoint generation
succeeds or fails. It creates no task step, binding attempt, request, or
WorkState. `run.maintain` is a separate runtime-triggered, control-only detour.
It exposes one bounded maintenance control, checkpoints an in-progress
WorkState, applies deterministic per-tool projection rules over exact journal
records, and restores the preceding mode. It does not rerun validation, mutate
resources, append `progress.md`, or delete run evidence. The other stored modes are `observe.locate`,
`observe.investigate`, `workstream.route`, and `execute`. A bound execute run
may temporarily observe and return directly to execute; it never resolves
again because the run binding is immutable.

Transition inputs are discriminated by destination. `observe.locate` accepts
non-authoritative `subjects`; investigation uses typed read-only `references`;
workstream and owner discovery use `workstream:search` or
`resource:ownership` in locate, and exact workstream inspection uses
`workstream:read` in investigate. `workstream.route` accepts only a concise
purpose and mounts no capability or action tool. Existing-workstream resolve
uses exact routed resource IDs, while bound execute uses typed
`mutationScopes`; new-workstream resolve uses typed `workspaceTargets` plus a
bounded creation proposal. The runtime, not the model, derives existing
activation paths, repository HEAD, eligible mutable roots, and evidence. Each
creation target declares `kind: file | directory` and a portable
`relativePath` beneath `context.run.workspaceRoot`; the model does not send
the workspace root, an absolute creation path, a resource id, or a
routing-evidence id.

Filesystem observation and mutation intentionally have different runtime
boundaries. The five core filesystem observation tools may use any explicit
canonical absolute path readable by the daemon's operating-system account;
omitted search roots still default to `<AYATI_ROOT_DIR>/workspace/`. This
machine-read path runs before workstream-resource enforcement and grants no
binding or write authority. Direct filesystem mutation tools may receive a
canonical absolute path inside the selected destination root or a
workspace-relative path. The execution wrapper resolves a relative path once
beneath the configured workspace, then rejects traversal and symbolic-link
escapes before preparation or execution.

Every primary decision receives that exact configured absolute path once as
`context.run.workspaceRoot`. The model treats “my workspace,” “the workspace,”
and “Ayati's workspace” as this location instead of searching the machine or
asking the user for an internal path. Filename-only and relative output
destinations resolve beneath it. The projection is a location fact only; it
does not grant resource authority or supply completion evidence.

A filesystem-only `file:read` transition does not require prior
target-grounding evidence: `read_files` and its executor policy validate the
call path, read scope, existence, file type, readability, bounded returned
content, and deterministic read result. `observe.locate` remains necessary
when the exact path is unknown.

The focused filesystem tools derive destination authority from
runtime-resolved creation targets or eligible authoritative mutable bindings
in the activated workstream; the model does not provide a permission token.
`create_directory`, `copy`, `move`, `delete`, and `set_permissions` retain one
selected destination root per call. Naturally batched `write_files` and
`patch_files` calls may use several separately selected roots only when every
target maps to one authorized root before execution; one unmatched target
rejects the complete batch.
`copy` may read an explicit source elsewhere, but only its selected-root
destination may change. Target-local verification observes the exact declared
entries and any created-parent or deferred-cleanup paths reported by the tool,
without recursively snapshotting the whole project.

`write_files` accepts complete desired UTF-8 content, derives current hashes
and kinds internally, stages changed files beside their destinations, and
atomically renames each file. Matching files return `unchanged`; a partially
completed batch can safely retry already-satisfied paths. Other focused tools
likewise distinguish completed, already-satisfied, partial, and failed
effects instead of pretending a multi-path call is one filesystem transaction.

Typical traces remain inside the one harness loop:

```text
greeting:    ENTRY -> direct response
clarify:     ENTRY -> direct clarification
preference:  ENTRY -> context.retrieve -> context_load -> ENTRY -> direct response
exact read:  ENTRY -> observe.investigate -> read -> validation(proof) -> direct response
vague read:  ENTRY -> observe.locate -> find -> observe.investigate -> read -> validation(proof) -> direct response
read choice: observe.locate -> find(multiple) -> chosen read or clarification
workstream question: observe.locate -> workstream search -> observe.investigate -> workstream read -> validation(proof) -> direct response
ownership ambiguity: observe.locate -> workstream search -> workstream.route -> resolve(ambiguous) -> decision_stop(needs_user_input)
mutation:    observe.locate/investigate -> ownership observation -> workstream.route -> resolve -> execute -> validation(proof) -> direct response
repair:      execute -> validation(failed) -> execute -> validation -> direct response
```

## Single-Agent Run Serialization

`IVecEngine` owns one in-memory FIFO queue shared by chat messages and system
events. A queued input does not prepare a run until every earlier run finishes
its full harness lifecycle. Shutdown drains active and queued work before
stopping the provider. Ayati is a single-agent system, so deterministic run
ordering is preferred over interleaved filesystem verification.

A verified `find_files` call with one or more results adds a small factual
`candidateSet` to that call's model-facing run context. It contains bounded
names, exact paths, actual kinds, and useful relative labels, and survives
tool-output compaction.
The model decides from the request whether to continue or ask through the
normal needs-user-input path. The runtime still checks target provenance where
required, resource authority, and every tool result, but it does not classify
the meaning of the user's choice. An exact filesystem read is the narrow
exception to prior target provenance; its current read result is still
verified.

The model never sees a separate workstream-resolution agent or lifecycle tool.
Before unbound mutation without matching exact focus, it observes durable
ownership through
`workstream:search` or `resource:ownership` in `observe.locate`, or through
`workstream:read` in `observe.investigate`. Direct `ENTRY -> resolve` is
unavailable. Exact persisted focus permits `ENTRY -> workstream.route` only for
its own workstream/request; otherwise a successful current-run ownership
observation unlocks the control-only route stage. That stage clears
observation tools, exposes the resolve controls, and can return to observation
if more evidence is needed. The model enters `resolve` only when it
semantically understands the user to want mutation or continuation. The
runtime does not classify greetings, information questions, or durable work
from word or sentence patterns before that decision. Workstream routing remains
available for every unbound, non-clarifying run; availability grants no binding
or mutation authority, and ordinary conversation still returns directly from
`ENTRY`. The deterministic gate does not classify user-message wording. It
requires a binding-required capability and one typed request-routing or
workstream-creation proposal.
Existing activation supplies the exact workstream, lifecycle choice, and
routed or focused resource IDs. It may use an empty list only when no selected
capability mutates a resource. The runtime uses them to ground activation, then
derives ownership, repository HEAD, evidence, and only those selected mutable
filesystem roots from the authoritative activated bindings. Creation instead
supplies typed `workspaceTargets`; the runtime derives their absolute selected
roots and routing evidence without pre-registering missing resources. The typed
`create` proposal is the model's semantic selection; the runtime does not
re-interpret user or assistant wording to decide whether "new", "fresh", or
"independent" was intended. The deterministic gate permits at most one
authoritative lifecycle binding and makes no model request. A lifecycle-route
rejection explicitly produced before any route
plan or run binding may receive one corrected proposal; every other failure
closes binding immediately, and a second no-change rejection also closes it.
After authoritative bound context is mounted, execution requires a fresh
primary decision.

Executable tools retain native schemas. Harness-only controls are not
persisted as fake calls. If a provider returns a whole JSON object whose shape
matches the input of a currently exposed native control, the harness treats it
as a text-encoded control attempt instead of a user-facing reply. It never
executes that object automatically; it requests one bounded repair so the
provider must emit a real native tool call. Unrelated JSON assistant replies
remain valid. Other invalid text-encoded calls and malformed schemas receive
the same bounded repair treatment.

## Workstream Observation and Deterministic Binding

The primary loop owns read-only workstream routing observations. It requests
focused capability ids instead of lifecycle effects:

```text
decision_enter_observe_locate({
  purpose: "Find the durable owner of result.txt before mutation.",
  capabilities: ["workstream:search", "resource:ownership"],
  subjects: ["result.txt"]
})
-> read-only routing observation step
decision_enter_workstream_route({
  purpose: "Use the verified owner observation to prepare binding."
})
-> control-only route stage; no executable tools
decision_resolve_create({
  purpose: "Bind the exact output before writing it.",
  capabilities: ["file:write"],
  workspaceTargets: [{ kind: "file", relativePath: "project/result.txt" }],
  binding: {
    title: "Result file",
    objective: "Create and maintain result.txt.",
    initialRequest: {
      title: "Create result.txt",
      request: "Create the requested result file.",
      acceptance: ["project/result.txt exists with the requested content."],
      constraints: []
    }
  }
})
-> deterministic binding gate (zero model calls)
-> runtime resolves <workspaceRoot>/project/result.txt and derives evidence plus the selected root
-> automatic execute entry with a replaced capability surface
-> refreshed authoritative context
-> fresh main decision
```

The model-facing routing observations are `workstream:search` and
`resource:ownership` in `observe.locate`, plus `workstream:read` in
`observe.investigate`. Their calls are persisted as ordinary observation
steps, and their ownership evidence remains routing-scoped. An exact
`workstream:read` also produces one separate typed
`workstream.snapshot_read` completion outcome. Read-only workstream questions
can validate that outcome and answer without binding; it cannot prove a
filesystem read or mutation. Mutation flows use the routing evidence, then
pass through `workstream.route`; observation modes cannot proceed directly to
resolve.

The gate checks binding-required taxonomy, the one-attempt limit, and verified
routing context. Creation and selection outside exact focus require a
successful current-run routing observation. It does not parse the user message
to duplicate the model's semantic judgment. For creation, it
validates every target kind and portable relative path, resolves and
canonicalizes it beneath the configured workspace, rejects traversal or
symbolic-link escape, and rechecks only whether an authoritative resource
already owns an exact selected target. Text similarity, recent activity,
title matches, and probable semantic candidates do not veto a typed create
proposal. A concrete ownership conflict performs no binding and immediately
returns one `needs_user_input` clarification to the user without another model
decision or retry loop.
For activation, the gate validates each model-selected resource ID against
current-run routing or exact focused context, derives the relevant evidence
and observed workstream HEAD, then rechecks candidate identity, request identity, mutable resource
ownership, availability, and HEAD freshness against Context Engine state.
Recent activity and referential wording remain discovery hints. Unless the
candidate was identified by exact identity or ownership, it must be inspected
before activation.

Read-only bindings are never upgraded into mutation authority.
For creation, the exact resolved file or directory targets become selected
mutation roots for the current run; missing targets are not pre-registered as
resources, and the whole workspace is never bound.
For activation, exact routed or focused resource IDs establish the right to
activate the existing owner and select current-run mutation authority. An
empty list is valid only when no selected capability mutates a resource. After
the authoritative activation projection is returned, the runtime mounts only
the selected resources that resolve to absolute filesystem bindings with
`mutate` access and are not missing or deleted. All other workstream resource
metadata remains projected for understanding, but it does not become mutation
authority. Each filesystem call selects one root; directory resources
authorize canonical descendants, not siblings or symbolic-link escapes.

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
- `agent_conversation_read`
- `agent_history_read`

Search locates a known topic, conversation read pages exact user, assistant,
and stored system-event messages backward from a stable stream snapshot, and
history read opens one exact message, range, run, or evidence reference. Hidden
system prompts and policies are not stream messages and are never returned.

Binding uses the already prepared agent stream and run; it never allocates a
second run. Existing workstreams require an explicit request operation:
continue, amend, activate queued work, resume blocked work, create a request,
or atomically defer and switch. After binding, the runner refreshes context
and asks for a new decision. A stale mutation call is rejected and never
stored for replay.

## Agent-Facing Context Pack

Prompt context uses explicit bounded lanes:

- `core`: one exact current input and routing state plus a continuity-target
  checkpoint, whole recent exact turns, and explicit unloaded ranges;
- `hot`: metadata for optional typed context plus bounded run-scoped entries
  mounted through `context.retrieve`, including recent-file navigation that
  can identify an exact read-only path but never grants authority or current
  content proof;
- `tools`: current capability surface;
- `harness`: compact unresolved repair feedback;
- `run`: the exact selected-request contract and distilled workstream context
  for a bound run, the exact configured `workspaceRoot`, WorkState, current
  calls, a compact `verifiedOutcomes`
  catalog, the virtual-mode card, pressure state, and an optional disposable
  anchored focus summary that is navigation context only. The bound-workstream
  projection identifies a different active request when necessary and carries
  at most five progress summaries for the selected request. Tool calls retain
  useful inputs, outputs, purposes, execution status, and one
  verification-status scalar; detailed verification records and completion
  evidence remain internal. Validation status and its runtime-resolved
  checklist appear in the mode card; the model selects exact `outcomeRef`
  values from `verifiedOutcomes` instead of reconstructing proof fields from
  tool output.

Full workstream documents and resource cards are not prompt lanes or Hot
Context entries. The bounded run projection includes at most ten resource
metadata records, ordered by selected-request relevance, primary role,
mutation access, availability, and recency. Each record may carry stable
identity, display metadata, public locator, role, access, availability,
primary status, and request relevance; `otherResourceCount` reports omitted
records. It omits file contents, versions, hashes, commit metadata, raw logs,
all other request files, and complete progress history. This metadata helps
the model choose a known resource but does not prove its current contents or
grant permission. Routing evidence stays in current-run tool calls, and
resource enforcement continues to use exact Context Engine state.

Expose only the exact shared workstream repository path as a read-only,
context-only navigation pointer. Do not expose per-workstream storage paths,
database paths, run storage paths, idempotency journals, observation authority
fields, or deferred mutation. `git_read` log/show/diff results never grant
binding or mutation authority; canonical workstream state must still be read.

## Mode-Scoped Capability Visibility

Tools have one purpose (`list`, `read`, `search`, `control`, `mutation`) and
one effect (`read_only`, `workspace_mutation`, `context_mutation`,
`external_mutation`, `destructive`). Unknown taxonomy fails closed.

At `ENTRY`, the executable capability surface is empty. The model sees a
compact catalog of exact capability identifiers plus the transition control.
The native schema exposes only graph-legal destinations and capabilities
available under current authority. The harness resolves each requested
responsibility to eligible concrete tools.

`observe.locate` and `observe.investigate` expose only read-only tools.
`workstream.route` is control-only and exposes no executable tools or
capabilities. Entering it replaces and clears the observation surface so tools
from an earlier mode do not accumulate. Bounded
self-transitions may adjust the surface; repeated identical transitions stop
through no-progress protection. `execute` enforces the selected-destination
policy for focused filesystem operations and the existing bound-resource
policy for other effects. Selecting a capability never authorizes its effect;
the matching execution policy still runs at call time.

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
`context.run.verifiedOutcomes`. Each entry contains a stable `outcomeRef`, a
human-readable kind and subject, relevant path kind, search scope, or read
scope, and its step/call/tool source. Only `outcomeRef` is selectable input;
the remaining fields explain what the runtime already proved.
Supporting facts, routing outcomes, invalidated proof, hashes, verification
contracts, checks, and methods stay internal. The adjacent tool-call
projection keeps its exact normal input and output; moving proof detail out of
that projection is not tool-input or tool-output compaction.

A failed permission call can also contribute one narrowly typed
`tool.call_denied` outcome when the runtime has exact call identity, a stable
denial code, and evidence that the requested operation did not occur. It is
not a successful call receipt and cannot satisfy read or mutation outcomes.

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
omitted from the model-facing prompt. A material WorkState projects only its
status, summary, optional plan, important context, and next action.
`context.run.boundWorkstream` is the single prompt owner of workstream and
request identity and bounded activated-resource metadata.

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
may be fulfilled, the model enters `validation` with one to twelve exact
current-run outcome references:

```text
decision_enter_validation({
  purpose: "Verify the important site outputs before responding.",
  capabilities: ["task:validation"],
  outcomeRefs: [
    "run:RUN-...:step:2:call:write-site:outcome:0",
    "run:RUN-...:step:3:call:test-site:task:1"
  ],
  criterionProofs: [
    {
      criterionIndex: 0,
      outcomeRefs: ["run:RUN-...:step:2:call:write-site:outcome:0"]
    },
    {
      criterionIndex: 1,
      outcomeRefs: ["run:RUN-...:step:3:call:test-site:task:1"]
    }
  ]
})
```

For a bound request, that same validation decision maps every zero-based
acceptance-criterion index to one or more of its selected `outcomeRefs`.
This is not another tool, mode transition, or model call. The runtime rejects
missing indexes, duplicate mappings, and references that were not selected by
the same decision. After validation passes, finalization copies the resolved
typed proof records—not assistant prose—into the durable criterion record.

The model never supplies `kind`, `subject`, `expectedKind`, `searchScope`,
`readScope`, `callId`, or `denialCode`. The runtime resolves each exact
reference against the derived current-run index and materializes the full
typed check itself. Unknown, cross-run, routing-only, supporting, and stale
references are rejected before validation is entered.

`path.exists` requires a verified current-run path-state result for the exact
subject and optional expected kind. `file.read_complete` requires a verified
current-run
`read_files` result whose explicit coverage is `complete`, whose content was
returned, and which has not been invalidated by a later mutation. Search
matches, profiles, samples, partial slices, failed verification, and
historical-run evidence do not satisfy it.

When the responsibility asks for a bounded read instead of the whole file,
the selected outcome resolves internally to a `file.read_scope_satisfied`
check carrying the exact verified `readScope`:

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

A verified positive `search_in_files` result produces one
`file.search_match` outcome per matched file. The outcome records only the
canonical path, query, line, and case policy needed for validation. It proves
that specific file matched; it does not prove that the search was exhaustive
or that the result was unique. A later mutation of the matched file
invalidates the outcome, while an unrelated file mutation does not.

A complete `search_in_files` count produces `file.search_count` with the exact
query, canonical roots, depth and hidden-file policy, case policy, count unit,
and total. Sampled or incomplete searches do not produce this outcome. Any
later filesystem mutation inside a counted root invalidates the count.
An ordinary exhaustive content search with zero matches produces the same
typed outcome with `totalMatchCount=0`; the absence remains valid only for its
exact recorded scope.

A conclusive zero-result `find_files` call produces
`file.search_no_match`. Its exact `searchScope` records the canonical roots,
depth, and hidden-file policy. The outcome exists only when traversal was
uncapped, error-free, and did not skip a directory at the depth limit. A later
filesystem mutation inside a searched root invalidates the negative proof.
Incomplete zero-result searches cannot prove that a target is absent.

Validation reuses these current outcomes rather than requesting fresh proof.
Equivalent read-only work is repeated only when earlier coverage was
insufficient or a later verified mutation invalidated it. Bounded overview
responses may select exact profile or slice outcomes and must describe their
coverage honestly instead of implying a complete-file read.

Registered semantic kinds cover calculator, database, Pulse, process, Python,
memory, and managed-artifact outcomes. `tool.call_succeeded` is an exact-call
fallback keyed by `callId`; it is emitted only by the existing deterministic
runtime verifier when no stronger completion outcome exists. Routing calls
never produce task-completion proof.

For a reportable permission denial, the model selects its exact outcome
reference. The runtime resolves it internally to:

```text
{
  kind: "tool.call_denied",
  subject: "call-17",
  denialCode: "PATH_OUTSIDE_MUTATION_WORKSPACE"
}
```

The exact check accounts only for the matching permission failure and records
the resolution as `denial_reported`. The call and step remain failed/denied in
the journal, unrelated failures stay active, and the outcome cannot masquerade
as operation success. The model still decides whether reporting the denial
fulfills the user's request; otherwise it uses a truthful blocked or failed
outcome.

Entering validation resolves only the selected references in the derived
current-run index and records the satisfying exact call reference on each
passed check. It does not call
`inspect_paths`, `read_files`, `process_run`, or any other action tool. If
proof is missing, ineligible, stale, or incomplete, the transition is rejected
with a direct repair reason. The agent returns to the appropriate work mode
and performs only the missing operation once.

A passed checklist unlocks a direct final response only when WorkState has no
remaining work, blocker, user-input need, or unresolved current-run failure. A
failed checklist keeps the virtual graph active. The agent returns to locate,
investigate, or bound execute, repairs the issue, and enters validation again.
On an accepted final response, the runtime—not the model—derives the bounded
completion receipts from the stored passed checklist, marks WorkState done,
marks its plan done, and removes the next action. The full assistant response
remains in message history. WorkState instead preserves an existing meaningful
checkpoint summary, derives a compact summary from completion receipts when
available, or records a small direct-response handoff.
Verified filesystem effects are projected independently from deterministic
per-call completion evidence, so partial physical progress survives an
incomplete or failed larger request. Generated deliverables remain the
intersection of passed filesystem validation subjects and artifacts actually
produced by successful mutation steps. The model may propose bounded semantic
metadata only for those exact paths; resource identity, kind, locator,
version, availability, and lifecycle remain deterministic. Missing semantic
metadata stays an explicit fallback.

`decision_stop` handles only non-successful terminal outcomes. It requires a
usable user-facing clarification when the model selects current ambiguity for
`needs_user_input`, or a current blocker/failure for `blocked` and `failed`.
The typed `needs_user_input` outcome is the model's semantic decision; the
runtime validates the control and response shape but does not second-guess it
with pronoun matching or phrases parsed from tool output. A current-run failed
filesystem mutation also blocks a completed reply until a later verified
mutation succeeds or exact denial validation accounts for it; this check does
not classify the user's wording.
Clarification acceptance does not depend on punctuation. Successful work never
uses `decision_stop`. A failed stop also keeps its user-facing response in
message history instead of copying it into WorkState.

One coordinator serves chat and system events. `finalizeRun` receives outcome,
stop reason, assistant response, summaries, validation, WorkState, completion
evidence, and a request lifecycle effect. It atomically appends the assistant
message and closes the run. A bound finalization appends one immutable progress
entry, creates one shared-repository commit, then returns independent resource
effects and workstream-context commit facts.

Response ordering is strict:

1. stream model text deltas if supported;
2. finalize and await durable acknowledgement;
3. send the terminal envelope with truthful context-commit state;
4. accept client render acknowledgement.

### Decision-limit closeout

Exhausting the primary decision budget does not make another model request and
does not discard partial progress. The runner performs one deterministic
closeout from the exact current-run journal before finalization:

```text
decision budget exhausted
-> preserve executor-verified resource effects and successful steps
-> pause active WorkState plan items and select one bounded next action
-> produce a truthful incomplete handoff response
-> finalize WorkState, resource effects, progress, and request state
-> dispatch the terminal response
```

This closeout validates only the facts it reports about partial work. It is not
task-completion validation and cannot mark an unfinished request done. A bound
request therefore remains active, verified effects still update the resource
catalog and `progress.md`, and an unbound run explicitly reports that it did
not create or activate a workstream/request. If full task validation passed on
the final allowed decision, the runner uses that accepted proof and completes
normally instead of misclassifying the run as limited.

The deterministic closeout is also the provider-independent fallback: it
always produces a bounded response even when no model budget remains.

A decision-provider or decision-runtime exception uses the same safety shape:
the runner makes no additional model call, pauses active plan items, preserves
executor-verified filesystem effects, and returns a failed handoff through
normal finalization. If that run has already bound, Context Engine derives
negative completion evidence from the authoritative binding and persisted
WorkState when the caller no longer has the refreshed bound projection.
Successful `done` finalization never receives this fallback and still requires
accepted completion evidence. Uncertain mutation or context-repository state
continues to become `recovery_required` instead of being forced closed.

Foreground generation requests disable provider-SDK retries and use an
explicit bounded timeout. The decision boundary classifies transport failures
without model involvement and retries at most one transient failure with the
same compiled input. Permanent account or request failures, cancellation,
unknown failures, and streaming failures after visible output are not retried.
An exhausted retry enters the deterministic unsuccessful closeout above.

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

The 8K Core Capsule continuity target is independent of these whole-request
thresholds. The current input and newest completed user/system-event turn with
its assistant response remain exact, even when that one turn exceeds the
target. When additional older whole turns do not fit, the prompt names their
unloaded exact sequence range. Before the task decision, the runtime
deterministically enters `context.maintain`, rolls the prior checkpoint and
eligible older complete turns into one replacement checkpoint only when the
replacement is expected to save at least 2K, then restores the preceding task
mode. Only the newest completed turn is protected during maintenance, which
creates headroom before another checkpoint is needed. This may happen even
when the complete prompt is far below 55K.

Recovery order is:

1. remove stable duplicate projections;
2. replace recoverable older output with typed previews and refs;
3. deterministically bound candidates and resources while preserving failures
   and the six-call hot window;
4. at measured soft pressure, enter `run.maintain`, persist a concise WorkState
   handoff, and adopt a source-hashed prompt-only tool projection;
5. if still needed, adopt a run-scoped anchored focus summary over eligible
   older current-run tool material;
6. rebuild and remeasure the whole request.

The next-decision reserve is `max(8K, soft - recovery)`. The forced barrier is
the active admission limit minus that reserve: 85K for the conservative 95K
local admission limit or 90K after an exact provider count permits the 100K
hard limit. At the barrier, the foreground waits once for a relevant candidate
and then performs synchronous deterministic/semantic recovery. A request is
never sent beyond its admission limit.

Conversation checkpoint generation happens only in `context.maintain`. It uses
a structured schema, exact message-sequence anchors, a strict 1,200-token
default budget, and at most one semantic model call per source identity. A
valid oversized candidate is deterministically fitted; invalid or unavailable
semantic output becomes a bounded exact-message fallback without another
model call. Generation is read-only; commit recomputes the serialized size,
and checkpoint plus active-pointer update occur only at validated atomic
adoption. The summary retains active requests, constraints, corrections,
unresolved questions, commitments, and needed references before durable
decisions and facts; it drops filler, repetition, resolved or superseded
material, transient failures, speculation, long quotations, and raw logs first.

Run maintenance never generates a conversation checkpoint. The model sees at
most 32 deterministic candidate records and may name at most 12 exceptions per
retention list. The latest six calls, failures, unrecoverable calls, active
process controls, WorkState-referenced calls, and unknown tool types remain
exact. Specialized known tools use typed projectors. Known tools without a
specialized projector may become a reference only when explicitly released;
unknown tools fail safe as exact. A released call is removed only from active
prompt payload: its exact run/step/call record remains retrievable.
A temporary focus summary is limited to 1,600 estimated tokens and one repair,
must anchor every statement, cannot replace current input, authority,
WorkState, unresolved failures, or completion evidence, and disappears at run
finalization/interruption/restart. If the final candidate is still unsafe, the
run ends as `incomplete/context_limit`.

The existing whole-request projection policy remains operational: `shadow`
prepares, validates, and measures run-focus/tool projections without mounting
them; `enforce` adopts valid candidates and activates forced-barrier behavior.
It does not disable required conversation maintenance.
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
