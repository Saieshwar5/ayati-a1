# Context and Memory

Ayati separates stream continuity, current-run execution, durable work,
resources, exact on-demand history, and personal memory. They have different
growth rates and different authority.

## Ownership

- Context Engine SQLite V12: agent streams, immutable messages, runs, steps,
  WorkState, checkpoints, workstreams, every request, progress projections,
  resources, discovery indexes, idempotency, and recovery journals.
- Shared workstream Git: compact portable `workstream.md`, request files,
  append-only `progress.md`, and generated `resources.json` only.
- Real resource locations: project files, documents, media, URLs, databases,
  repositories, and external objects.
- Personal memory: stable, evolving, and time-scoped facts about the user.
- Hot Context runtime: rebuildable typed catalog plus disposable run-scoped
  mounts. It is a projection cache, never the source of truth.
- Episodic memory: semantic recall over prior experience.
- Active-run projection: the harness keeps the latest authoritative service
  response for the current turn; it does not maintain a second context cache.
- Agent-stream workstream focus: one optional durable workstream/request pair
  for unfinished continuation across runs. It is not binding or authority.
- Context preparation: one runtime-owned, in-memory candidate lane per main
  run. Candidates and focus overlays are disposable;
  only an adopted Context Engine checkpoint becomes durable.

## Agent Stream Continuity

An agent stream is the slow-growing continuity boundary across many runs and
communication clients. The default local identity is:

```text
agentId = local
scopeKey = default
```

The stream contains immutable `user`, `system_event`, and `assistant`
messages. Assistant messages durably retain `reply`, `feedback`, or
`notification` response semantics and an optional feedback kind. User messages
retain the exact resource identities admitted as attachments for that message.
The stream also contains a durable continuity checkpoint plus exact tail,
recent completed-work references, and relevant resources. It does not contain
action logs. Older exact messages and run evidence remain queryable through
stable history references.

Every accepted input creates one run. There are no daily context sessions,
conversation segments, rollover jobs, or optional transcript materialization.

## Run Context

A run is the fast-growing compute, audit, finalization, and recovery boundary
for one accepted input. It contains:

- current WorkState;
- ordered structured steps;
- complete tool-call inputs/results or hashes;
- deterministic verification and evidence;
- pressure and recovery state.

A run may remain unbound for conversation or observation, or gain one
immutable workstream/request binding. Finalization projects only the small
facts that need to survive into stream or workstream continuity.

Every active-run context rebuild derives discovery text from that run's
immutable ingress message in SQLite. Initial preparation, persisted steps,
WorkState checkpoints, binding checks, and restart recovery therefore rank
workstream candidates from the same input instead of relying on caller state.

The next run receives a fresh WorkState. When it continues the exact same
unfinished request, a compact material handoff may initialize that new
WorkState, while the latest five progress entries for the selected request are
loaded separately from the durable progress projection.

An unfinished bound request also becomes the stream's focused workstream. Its
compact `context.core.focusedWorkstream` projection survives restart and lets a
clear continuation enter routing without rediscovery. The projection includes
the selected request's exact stored outcome, but leaves its acceptance criteria
and constraints for an exact workstream read or the post-binding context.
Binding another owner swaps focus. A matching `done` or `dropped` finalization
clears it. Unbound and read-only runs leave it unchanged and create no
workstream progress.

Workstream routing is part of the same primary loop. Before an unbound
mutation, candidate and owner lookups run in `observe.locate`, while exact
workstream context reads run in `observe.investigate`. Those calls enter the
run step history but are tagged as routing evidence. A successful current-run
observation unlocks the control-only `workstream.route` stage; exact focused
context unlocks the same stage only for its own IDs. It adds no action tools
or duplicate context. `resolve` is available only from that
stage, while routing may return to observation if evidence is incomplete.
`resolve` remains a transient deterministic gate with no private history,
model call, prompt lane, WorkState, token budget, or retry loop. It validates
one typed proposal, calls one atomic
Context Engine binding path, and publishes the refreshed projection to the
next primary decision.

## Agent-Facing Prompt Lanes

The model receives an explicit bounded projection:

- `context.core`: the exact current input and routing state plus the small
  continuity checkpoint, bounded exact tail, explicit unloaded ranges, and an
  optional compact focused unfinished workstream/request projection;
- `context.hot`: a small catalog of optional typed entries plus content
  explicitly mounted for this run;
- `context.tools`: current capability surface;
- `context.harness`: compact unresolved repair feedback;
- `context.run`: on a bound run, `boundWorkstream` with distilled project
  context, the exact selected request, an optional different active-request
  identity, at most five selected-request progress summaries, and at most ten
  bounded resource metadata records; material WorkState when present; the
  exact runtime-configured absolute `workspaceRoot`; current-run calls; a
  compact `verifiedOutcomes` catalog; the run-scoped mode card; pressure
  state; and an optional run-pressure `focus` overlay. This overlay is distinct
  from durable agent-stream workstream focus. Resource records include stable
  identity, display metadata, public locator, role, access, availability,
  primary status, and selected-request relevance, plus an omitted count. They
  do not include contents, hashes, complete version history, or permission
  tokens. New-workstream `workspaceTargets` and relative
  filesystem-mutation paths use the workspace root without repeating it. The
  workspace root and projected resource metadata are context, not completion
  evidence. Existing activation supplies exact resource IDs from current-run
  routing; the runtime derives authority from the authoritative workstream
  bindings rather than asking the model to reproduce paths or evidence
  fields. The overlay and prior progress are likewise context only. Tool calls
  keep useful exact inputs and outputs plus a scalar verification status; full
  verification machinery remains in the journal. The mode card exposes the
  current validation checklist and per-path status. Completion selects
  catalog kind/subject values instead of copying current-call evidence
  identifiers.

Internal database paths, context-repository paths, observation authority
fields, private storage locators, commit metadata, raw logs, idempotency data,
and recovery journals are not model-facing.

## Core Capsule

`context.core` is the small continuity context included in every primary
decision. It replaces the former model-facing `temporal`, `current`, and
`stream` prompt objects. It does not replace the immutable message journal,
run state, WorkState, resource authority, Hot Context, or exact history
access.

The capsule has three explicit parts:

- `current`: one exact current user or system-event input, the current run id,
  exact routing state, and at most five lightweight active-document navigation
  pointers;
- `continuity`: an optional durable checkpoint, recent whole exact turns, and
  any older sequence ranges not mounted in the capsule;
- `budget`: the continuity target and current estimate.

Every exact event keeps its authoritative stream sequence. Assistant events
also project response/feedback kind, and user events project only the
attachments linked to that exact message. These fields are relationship clues,
not a rigid reply graph: the current user may answer an earlier question,
revise or combine an answer, ignore the question, or start a new request. The
decision prompt resolves short replies against the nearest semantically
compatible feedback event and asks for clarification when more than one
referent remains plausible. Ayati does not manufacture a durable `replyTo`
relationship from adjacency alone.

The current input is stored once under `core.current.input` and is not charged
to the historical continuity budget. The initial continuity budget is 8,000
estimated tokens, including checkpoint, exact tail, and continuity metadata.
Selection is newest-first by complete turn; an individual message is never
partially cut. The newest completed user/system-event turn and its assistant
response are the minimum exact tail and remain exact even when that one turn
exceeds the continuity target. Additional older turns become unloaded ranges
and eligible checkpoint source. Maintenance summarizes older exact turns too,
protecting only that newest completed turn so a successful checkpoint creates
real breathing room. Whole-request admission remains the hard provider safety
boundary.

`core.current.activeDocuments` is derived from the newest verified successful
complete historical file reads belonging to stable terminal runs in the same
stream. A terminal run may be done, incomplete, failed, blocked, or waiting for
user input; its overall outcome does not invalidate an earlier successful read.
Running and recovery-required runs are excluded. Each pointer contains only
filename, canonical path, last-read time, evidence reference, optional
request/response sequence clues, and `freshness: "unchecked"`. The five
pointers are outside the conversational checkpoint and survive checkpoint
projection unchanged. They help a follow-up skip rediscovery, but they contain
no file content, grant no authority, and require one fresh read when current
contents matter.

Capsule evolution is automatic:

1. Immutable user, assistant, and system-event messages are appended to the
   Context Engine journal together with exact assistant-response metadata and
   per-message attachment links.
2. Before a decision, the runtime builds the capsule from the active durable
   checkpoint and exact journal tail.
3. If it fits, no summary call or checkpoint write occurs.
4. If older turns do not fit, the capsule keeps its minimum exact tail, reports
   exact `unloadedRanges`, and leaves the source messages unchanged.
5. Independently of whole-prompt pressure, the runtime enters
   `context.maintain` and asks Context Engine for a source-hashed plan over
   complete terminal runs before the protected exact tail.
6. A beneficial plan is summarized with exact sequence anchors, revalidated,
   committed atomically, and replaced by the commit's fresh checkpoint plus
   exact tail.
7. The runtime restores the exact prior task mode. If no beneficial complete
   prefix exists or generation fails, no durable state changes; the explicit
   unloaded range remains recoverable through exact history search/read.

The capsule itself is never the recovery source. After a crash or restart,
Ayati rehydrates immutable messages, assistant-response metadata, message
attachments, and the active checkpoint from Context Engine, then rebuilds the
same bounded capsule deterministically.

This gives the capsule its own small growth boundary. It no longer waits for a
55K whole-prompt threshold before normal conversational continuity is reduced.
Authority and execution truth never enter the summary: routing, WorkState,
resource access, current-run calls, validation, and failures are rebuilt from
their exact owners on every decision.

## Hot Context

`context.hot` keeps optional context out of every prompt until it is relevant.
It contains:

- `available`: metadata only (`key`, description, version, estimated tokens,
  freshness, and source refs);
- `loaded`: the same metadata plus bounded content mounted for the current run.

The current sources are:

- `personal.memory`, rebuilt from `PersonalMemorySnapshotCache`;
- `workstreams.recent`, a metadata-only list of at most ten distinct
  workstreams ordered by their latest creation, open, or binding activity;
- `workstates.recent`, historical handoffs from at most five recent material
  terminal runs in the current agent stream;
- `files.recent`, metadata for the older portion of the same recent-document
  registry: at most 27 records after the five active pointers.

`workstreams.recent` contains identity, title, lifecycle/repository health,
compact current-request metadata, and the latest activity kind/time. It does
not contain objectives, summaries, blockers, next actions, resources,
repository paths, Git heads, or run evidence. It replaces the old
always-projected per-finalization recent-work lane. After using it for
navigation, the agent must read current authoritative workstream state before
selection or binding.

`workstates.recent` contains the terminal run status and stop reason, WorkState
status, summary, optional plan, important context, next action, exact run and
message references, and optional bound workstream/request identity. It excludes
the current active run, recovery-required runs, initial WorkStates, and trivial
completed conversations with no plan, important context, next action, or
workstream binding. The summary is a compact operational handoff, not a copy of
the assistant response already available in message history. Records are newest
first and deduplicated by run id.

The source is rebuilt directly from existing SQLite `runs`,
`run_work_state`, `messages`, and workstream metadata; there is no second
WorkState table or copied cache record. It is a historical handoff for
navigation and continuation, not current authority or completion evidence.
The current run WorkState and fresh authoritative workstream/resource reads
always override it. Exact details remain recoverable from each advertised
`run:*` source reference.

The recent-document registry contains at most 32 canonical paths, newest first
and deduplicated by path. It is rebuilt from exact verified successful
complete-read steps belonging to stable terminal runs after every projection
or restart; no new table or copied cache record exists. The first five
lightweight pointers appear in `core.current.activeDocuments`. The remaining
records are available through `files.recent`, including filename, path, last
complete-read time, request/response sequence clues, exact run-step-call
evidence reference, and available size/line/hash metadata.

Neither view contains file content or makes a freshness/existence claim.
Loading `files.recent`, or using an active pointer directly, lets a referential
follow-up enter `observe.investigate` with the known path instead of searching
again. That path is read-only navigation grounding only: normal
workspace/resource admission still applies, and it cannot ground resolve,
execute, mutation, or completion.

Current workstream details and complete resource cards are intentionally not
Hot Context sources. A bound run receives the selected contract, distilled
workstream fields, and bounded resource metadata directly. The agent obtains
complete workstream history, unprojected resources, and actual file state
through the relevant read-only tools when the task requires it.

Empty sources are not advertised. Source content is versioned by hash; a
mounted entry is invalidated if its source disappears or changes.

The model enters the transient read-only `context.retrieve` mode with the
`context:load` capability and calls `context_load` with one or more advertised
keys. The tool returns only a small receipt. Full content appears once under
`context.hot.loaded` on the next decision, rather than being duplicated in the
tool result. The runtime then returns automatically to `ENTRY` or the
preceding observation/execute mode and restores its capability surface.
When no unloaded entry remains, the mode and capability are omitted from the
decision surface; the runtime also rejects a stale retrieval attempt.

Hot Context loading is not task progress:

- it does not modify WorkState;
- it does not create a durable task step;
- it grants no resource authority and supplies no completion evidence;
- it cannot be entered from validation;
- it does not perform checkpointing, summarization, or pressure management.

Mounts are keyed by client and run, enforce one deterministic combined token
budget, and are cleared when the run exits, including exceptional exits.
Run-scoped sources are rebuilt in memory whenever authoritative harness context
changes. An unchanged version preserves its mount; a changed version removes
the stale mount and advertises the new entry. Catalog/source data remains
rebuildable after restart.

There is intentionally no reusable `actions` lane. Action truth already lives
in the run step journal, resource effects, and exact evidence. WorkState keeps
only the small amount of selected continuity needed to resume the run,
including at most four compact receipts derived from passed final-validation
checks when a responsibility completes.

## Exact Run Evidence

Every tool call already has one authoritative owner: its exact run step. The
step journal stores the call input, result or hash, classification, and
deterministic verification. Ayati does not copy successful read outputs or raw
verification into either WorkState or a second cross-run observation table.
At successful completion only, the runtime may promote the selected passed
read check into a small WorkState receipt containing its bounded canonical
subject, validated coverage or scope, and exact run/step/call reference.

Whole-task validation derives a current-run verified-outcomes index from this
journal. The index is rebuildable, run-scoped, and in memory only. It
normalizes completion evidence and verified facts, preserves exact
run/step/call references, separates failed and unavailable calls, marks
routing evidence as non-completion context, and removes filesystem proofs
invalidated by later known mutations. The index therefore improves validation
without becoming a second persistence path. A filtered completion-only
projection appears inside `context.run.verifiedOutcomes`; it is not a new
top-level lane or authority source. Each projected item has an exact stable
`outcomeRef`. The model selects that reference while the runtime retains
ownership of the underlying kind, subject, scope, denial code, and source.

The model-facing tool-call projection deliberately excludes verification
methods, contracts, checks, verified-fact payloads, compatibility booleans,
and raw filesystem completion-evidence objects. It retains the exact normal
tool input and output, purpose, execution/operation status, one compact
verification status, actionable verification failure, artifacts,
continuation/truncation signals, and routing evidence references. Full call
and verification records remain durable and continue to rebuild the index
after restart.

Current-run calls needed for the next decision remain in `context.run`. Older
evidence is cold context and is retrieved only when needed:

1. `agent_history_search` searches messages, WorkState summaries, or exact
   run-step call records.
2. `agent_conversation_read` pages exact stream messages chronologically when
   topic search is insufficient. Older successful page payloads are replaced
   in active prompt context when the next page arrives; exact records remain.
3. An evidence hit returns a stable `run:*:step:*:call:*` reference.
4. `agent_history_read` reads that exact journal record with deterministic
   character bounds and continuation.

This keeps one source of truth and prevents repeated reads from creating an
ever-growing parallel evidence lane. The bounded `files.recent` index contains
only navigation metadata derived from these records. Historical read results remain historical:
they grant no resource authority and do not prove that an external file is
still current. The agent rereads a source only when the current request
requires fresh content or when a later mutation invalidated the current run's
read proof. Final validation consumes current-run completion evidence and does
not itself repeat a read.

Durable ownership remains explicit:

- full user-facing assistant responses stay in conversation messages;
- current action detail stays in run steps and tool calls;
- selected progress, the optional plan, essential constraints, next action,
  and bounded terminal completion receipts stay in WorkState;
- the optional `workstates.recent` view is derived from those authoritative
  terminal WorkStates and is never persisted as another memory record;
- files, external objects, artifacts, and mutation effects stay in resources
  and verification journals;
- work decisions stay in workstream/request context;
- user facts and preferences stay in personal memory.

## Parallel Context Preparation

Every primary decision starts from a structured prompt manifest. Parts carry a
stable id, `system`/`session`/`work` lane, retention class, source refs, and a
local estimate. System/safety instructions, selected native tool schemas,
current input identity/content, routing state, bound selected-request context,
material WorkState, failures, the completion-only verified-outcome catalog,
and the latest six main calls are always rebuilt from current authoritative
state.

The manager identifies a stable source prefix by canonical hashes and step
watermarks. At 55K in the default profile, or when current input plus the 15K
lead predicts crossing 70K, it may prepare one disposable run-focus candidate
from eligible older current-run tool material beside foreground model work.
It does not summarize conversation messages. One semantic call may be active
per provider. Identical prefix/policy/profile jobs deduplicate; errors become
failed candidates, and late results after lane closure are measured and
discarded.

A ready candidate is valid only for its exact lane, policy/model profile,
checkpoint base, source hashes, and required exact refs. Append-only tail
growth is allowed. Changed sources, bases, lanes, refs, or policy versions make
the candidate stale without changing authoritative state.

Generation may span observation, binding, or execution, but a candidate never
owns navigation state. The current mode card, current input, bound selected
request, binding/resource authority, WorkState, failures, completion evidence,
artifacts, and routing evidence references are rebuilt or retained exactly at
adoption. A candidate prepared before binding may therefore summarize an
unchanged older prefix, but it cannot restore an unbound mode, replace the
selected request, or replace newly mounted execute authority. Finalization
closes the lane; late results are recorded and discarded.

## Conversation Context Maintenance

The durable source-anchored checkpoint mechanism has one trigger and one
runtime owner:

- `context.maintain` runs when the Core Capsule continuity budget is exceeded.

The model cannot select this mode. The runtime enters it before the next task
decision, exposes no task tools or normal reply, and restores the exact prior
mode after success or failure. It does not create a run step, request,
workstream, binding attempt, or WorkState checkpoint.

For each maintenance attempt:

1. Ask Context Engine for a plan over a complete prefix of terminal runs
   before the protected exact tail. The current input and newest completed
   user/system-event turn with its assistant response are never summarized.
2. Refuse a plan unless replacing the previous checkpoint and selected older
   turns is expected to save at least 2,000 tokens.
3. Make at most one bounded semantic generation call over the previous
   checkpoint plus newly selected older messages. Accept a valid result,
   deterministically fit a structurally valid oversized result, or construct a
   deterministic exact-message fallback when generation is invalid or fails.
   Retain active requests, constraints, corrections, unresolved questions,
   assistant commitments, and needed references first; then durable decisions,
   confirmed facts, preferences, and definitions. Forget filler, repetition,
   resolved or superseded material, abandoned alternatives, transient failures,
   unsolicited offers, speculation, long quotations, and raw logs first. Do not
   commit the candidate yet.
4. Preview the candidate with its exact tail and measure the complete provider
   request before committing it. At a forced barrier, a candidate that cannot
   reduce the request is rejected.
5. At adoption, revalidate the base/source and atomically commit the checkpoint
   and active pointer through Context Engine.
6. Replace the loop projection with the fresh commit response, then rebuild and
   measure checkpoint plus exact tail.

The default checkpoint budget is a strict 1,200 estimated tokens. Semantic
generation targets a smaller result and receives a provider-side output
ceiling. The deterministic fitter validates anchors, removes exact duplicates,
orders statement categories by continuity priority, and measures the complete
serialized summary after every admitted item. If semantic output is malformed,
truncated, unanchored, or unavailable, the fallback combines the previous
checkpoint with bounded exact excerpts from the selected message prefix. The
same source-identity job is attempted only once.

A checkpoint never grants authority; every statement cites an exact retained
message sequence. The current input and exact recent tail remain outside the
checkpoint, and exact older messages remain recoverable through history tools.
WorkState, current-run tools and evidence, active documents, resource authority,
failures, workstream state, and personal memory are never fallback source
material. Failed or unnecessary plans do not change durable state. Whole-request
pressure is separate: it compacts older tool output and may create a disposable
run-focus overlay, but it cannot create or rewrite the conversation checkpoint.

## Current-Run Context Maintenance

Whole-request soft pressure is handled separately from conversation
checkpointing. When older current-run tool material can be reduced, the
runtime suspends the current task mode in `run.maintain`. The prompt contains
one bounded source-hashed inventory and exposes only
`decision_maintain_run_context`.

That decision supplies a concise in-progress WorkState handoff and at most
twelve references in each of three exception lists: keep exact, keep a typed
compact preview, or release to a recoverable journal reference. The model does
not provide token counts, verifier status, projector ids, or authority. The
runtime rechecks the maintenance id, WorkState revision, exact run-journal
source hash, allowed references, mandatory exact calls, and per-tool policy.

The resulting overlay is active-prompt state only. It never edits or deletes
the exact run-step journal and never updates `progress.md` before finalization.
New tool calls append exact after the maintained prefix. If later calls create
new pressure, a new source hash may trigger maintenance again; the same source
cannot loop. Invalid semantic input receives one bounded retry, then the
runtime uses its safest deterministic defaults. Unknown tools remain exact.
After WorkState persistence and overlay adoption, the exact preceding task
mode and capability surface are restored.

The current-run WorkState is the semantic handoff owner. A temporary focus
overlay below is only a forced-capacity fallback and must not become a second
durable WorkState or conversation summary.

## Temporary Focus Overlays

When whole-request recovery needs more space, the runtime may summarize only
eligible older current-run tool previews and a prior focus into
`context.run.focus`. It does not summarize conversation messages. Every
statement cites a valid step, call, evidence, artifact, or prior-focus ref;
the complete summary is limited to 1,600 estimated tokens and one repair.
Current input, the bound selected-request context, WorkState,
binding/resources, unresolved failures, and completion evidence are never
source material. Covered exact prompt material is replaced, while new
calls/steps append as an exact tail.

The overlay lasts only for the current run. Finalization, interruption, or
restart discards it. The next run starts from the canonical stream checkpoint
and bounded exact tail; older exact content remains available through history
search/read.

## Exact History Access

`agent_history_search` searches older messages, run summaries, and evidence.
`agent_conversation_read` returns the latest page, or messages before an exact
sequence, and follows a stable `olderCursor`. The first page pins a sequence
high-water mark, so later appends cannot duplicate or skip entries while the
agent pages backward. Each page contains at most 50 stored user, assistant, or
system-event messages in chronological order. `agent_history_read` reads a
stable `message:*`, `seq:*`, `run:*`, or exact run/step/call reference, or an
inclusive sequence range, with deterministic character bounds and content
continuation.

Search defaults to 10 hits and caps at 25. Conversation and range reads cap at
50 messages and 32,000 message-content characters. Retrieval is current-stream
only and does not expose hidden system prompts. It does not inject unbounded
transcripts into every decision.

## Personal and Episodic Memory

Personal memory is independent from streams and workstreams. A preference may
influence many kinds of work without belonging to any one of them. Automatic
personal-memory extraction runs on newly committed checkpoint event ranges,
using only exact user/assistant messages covered by that checkpoint. Accepted
memory cards regenerate the compact snapshot advertised as the
`personal.memory` Hot Context source. The snapshot content is no longer
injected into every decision.

Episodic recall remains a separate semantic retrieval system. Neither memory
system grants resource access or mutation authority.

## Context Pressure and Recovery

Pressure preserves exact current input, binding/resource ownership, WorkState,
and recent run evidence before lower-value projections. Below the forced
barrier, a foreground decision may continue while preparation is pending. At
or above it, the runtime waits once and performs synchronous recovery. If the
final bounded candidate remains inadmissible or above the forced barrier, the
run ends as `incomplete/context_limit`.

Startup closes an abandoned safe run as `incomplete/interrupted`. Journaled
finalizations and resource operations resume idempotently. Unresolved recovery
blocks another run in the same agent stream.
