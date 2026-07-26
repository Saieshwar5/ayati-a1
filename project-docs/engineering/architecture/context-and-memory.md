# Context and Memory

Ayati separates stream continuity, current-run execution, durable work,
resources, exact on-demand history, and personal memory. They have different
growth rates and different authority.

## Ownership

- Context Engine SQLite V8: agent streams, immutable messages, runs, steps,
  WorkState, checkpoints, workstreams, requests, resources, discovery indexes,
  idempotency, and recovery journals.
- Workstream Git: compact portable `workstream.md`, request files, and
  `resources.json` only.
- Real resource locations: project files, documents, media, URLs, databases,
  repositories, and external objects.
- Personal memory: stable, evolving, and time-scoped facts about the user.
- Hot Context runtime: rebuildable typed catalog plus disposable run-scoped
  mounts. It is a projection cache, never the source of truth.
- Episodic memory: semantic recall over prior experience.
- Active-run projection: the harness keeps the latest authoritative service
  response for the current turn; it does not maintain a second context cache.
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

Workstream routing observation is part of the same primary loop. Read-only
candidate and owner lookups enter the run step history but are tagged as
routing evidence. `resolve` is a transient deterministic gate with no private
history, model call, prompt lane, WorkState, token budget, or retry loop. It
validates one typed proposal, calls one atomic Context Engine binding path,
and publishes the refreshed projection to the next primary decision.

## Agent-Facing Prompt Lanes

The model receives an explicit bounded projection:

- `context.core`: the exact current input and routing state plus the small
  continuity checkpoint, bounded exact tail, and explicit unloaded ranges;
- `context.hot`: a small catalog of optional typed entries plus content
  explicitly mounted for this run;
- `context.tools`: current capability surface;
- `context.harness`: compact unresolved repair feedback;
- `context.run`: material WorkState when present, current-run calls, a compact
  `verifiedOutcomes` catalog, the run-scoped mode card, pressure state, and an
  optional `focus` overlay. The overlay is context only and is never
  verification or completion evidence. Tool calls keep useful exact inputs
  and outputs plus a scalar verification status; full verification machinery
  remains in the journal. The mode card exposes the current validation
  checklist and per-path status. Completion selects catalog kind/subject
  values instead of copying current-call evidence identifiers.

Internal database paths, context-repository paths, observation authority
fields, idempotency data, and recovery journals are not model-facing.

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
- `budget`: the strict continuity limit and current estimate.

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
to the historical continuity budget. The initial continuity budget is 4,000
estimated tokens, including checkpoint, exact tail, and continuity metadata.
Selection is newest-first by complete turn; an individual message is never
partially cut. If even the newest historical turn cannot fit, it is named in
an unloaded range and becomes eligible checkpoint source rather than silently
overflowing the capsule.

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
4. If it does not fit, the model-facing capsule immediately remains bounded
   and reports exact `unloadedRanges`; the source messages remain unchanged.
5. Independently of whole-prompt pressure, the runtime asks Context Engine for
   a source-hashed plan over complete terminal runs before the current input.
6. A beneficial plan is summarized with exact sequence anchors, revalidated,
   committed atomically, and replaced by the commit's fresh checkpoint plus
   exact tail.
7. If no beneficial complete prefix exists or generation fails, no durable
   state changes. The explicit unloaded range remains recoverable through
   exact history search/read.

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
workstream binding. Records are newest first and deduplicated by run id.

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

Current workstream details and current resource cards are intentionally not
Hot Context sources. The agent obtains exact current workstream, ownership,
resource, and file state through the relevant read-only tools when the task
requires it.

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
top-level lane or authority source.

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
2. An evidence hit returns a stable `run:*:step:*:call:*` reference.
3. `agent_history_read` reads that exact journal record with deterministic
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
current input identity/content, routing state, material WorkState, failures,
the completion-only verified-outcome catalog, and the latest six main calls
are always rebuilt from current authoritative state.

The manager identifies a stable source prefix by canonical hashes and
message/step watermarks. At 55K in the default profile, or when current input
plus the 15K lead predicts crossing 70K, it may prepare one disposable hybrid
candidate beside foreground model work. One semantic call may be active per
provider. Identical prefix/policy/profile jobs deduplicate; errors become
failed candidates, and late results after lane closure are measured and
discarded.

A ready candidate is valid only for its exact lane, policy/model profile,
checkpoint base, source hashes, and required exact refs. Append-only tail
growth is allowed. Changed sources, bases, lanes, refs, or policy versions make
the candidate stale without changing authoritative state.

Generation may span observation, binding, or execution, but a candidate never
owns navigation state. The current mode card, current input, binding/resource
authority, WorkState, failures, completion evidence, artifacts, and routing
evidence references are rebuilt or retained exactly at adoption. A candidate
prepared before binding may therefore summarize an unchanged older prefix,
but it cannot restore an unbound mode or replace newly mounted execute
authority. Finalization closes the lane; late results are recorded and
discarded.

## Durable Continuity and Pressure Checkpoints

The same source-anchored checkpoint mechanism serves two triggers:

- Core Capsule maintenance when its small continuity budget is exceeded;
- whole-provider-request recovery when the complete prompt approaches model
  pressure.

For either trigger:

1. Ask Context Engine for a plan over a complete prefix of terminal runs
   before the protected current input.
2. Refuse a plan whose checkpoint would not provide the requested savings.
3. Generate a structured summary with exact message-sequence anchors, allowing
   at most one repair, but do not commit it yet.
4. At adoption, revalidate the base/source and atomically commit the checkpoint
   and active pointer through Context Engine.
5. Replace the loop projection with the fresh commit response, then rebuild and
   measure checkpoint plus exact tail.

The default checkpoint estimate is 1,200 tokens. A checkpoint never grants
authority; every statement cites an exact retained message sequence. Failed or
unnecessary plans do not change durable state. Whole-request pressure still
compacts older tool output before it escalates to semantic checkpoint or focus
preparation. Current work and resource records stay with their authoritative
owners and are not pressure-managed prompt lanes.

## Temporary Focus Overlays

When an eligible durable checkpoint cannot recover enough space, the runtime
may summarize only covered older prompt material into `context.run.focus`.
Every statement cites a valid message, step, call, evidence, or artifact ref;
the complete summary is limited to 1,600 estimated tokens and one repair.
Current input, WorkState, binding/resources, unresolved failures, and
completion evidence are never source material. Covered exact prompt material
is replaced, while new calls/steps append as an exact tail.

The overlay lasts only for the current run. Finalization, interruption, or
restart discards it. The next run starts from the canonical stream checkpoint
and bounded exact tail; older exact content remains available through history
search/read.

## Exact History Access

`agent_history_search` searches older messages, run summaries, and evidence.
It returns stable refs such as `message:*`, `seq:*`, `run:*`, or an exact
run/step/call evidence ref. `agent_history_read` reads a ref or inclusive
sequence range with deterministic bounds and continuation cursors.

Search defaults to 10 hits and caps at 25. Reads cap at 50 messages and 32,000
characters. History retrieval does not inject unbounded transcripts into every
decision.

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
