# Context and Memory

Ayati separates stream continuity, current-run execution, durable work,
resources, reusable observations, and personal memory. They have different
growth rates and different authority.

## Ownership

- Context Engine SQLite V7: agent streams, immutable messages, runs, steps,
  WorkState, checkpoints, reusable observations, workstreams, requests,
  resources, discovery indexes, idempotency, and recovery journals.
- Workstream Git: compact portable `workstream.md`, request files, and
  `resources.json` only.
- Real resource locations: project files, documents, media, URLs, databases,
  repositories, and external objects.
- Personal memory: stable, evolving, and time-scoped facts about the user.
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
messages, a pressure checkpoint plus exact tail, recent completed-work
references, relevant resources, and reusable observations. It does not contain
action logs. Older exact content remains queryable through stable history
references.

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

- `context.temporal`: durable checkpoint and exact recent message tail;
- `context.current`: current input sequence/run identity and routing state; the
  exact input content appears once in `context.temporal.recent`;
- `context.stream`: stream identity and recent work references;
- `context.work`: at most five candidates and the optional single active
  workstream/request;
- `context.resources`: stream, ingress, and active-workstream resources;
- `context.observations`: valid reusable inventory/discovery/evidence;
- `context.personal`: compact personal-memory snapshot;
- `context.tools`: current capability surface;
- `context.harness`: compact repair feedback;
- `context.run`: WorkState, current-run calls, the compact run-scoped mode card,
  pressure state, and an optional `focus` overlay. The overlay is context only
  and is never verification or completion evidence.

Internal database paths, context-repository paths, observation authority
fields, idempotency data, and recovery journals are not model-facing.

There is intentionally no reusable `actions` lane. Action truth already lives
in the run step journal and is reduced into WorkState, workstream continuity,
resource effects, or exact evidence when it must survive.

## Reusable Observations

Only successful read-only tools with purpose `list`, `search`, or `read`
produce reusable observations:

- `inventory`: bounded list results;
- `discovery`: bounded search results;
- `evidence`: bounded read results with an exact run/step/call reference.

Each observation records the versions of referenced resources. A resource
version change invalidates the observation before projection. Current-run tool
calls are not duplicated in this lane, and mutations never become reusable
observations.

## Parallel Context Preparation

Every primary decision starts from a structured prompt manifest. Parts carry a
stable id, `system`/`session`/`work` lane, retention class, source refs, and a
local estimate. System/safety instructions, selected native tool schemas,
current input identity/content, active authority, WorkState, open work,
failures, verification/completion evidence, and the latest six main calls are
always rebuilt from current authoritative state.

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

## Durable Pressure Checkpoints

Checkpoints are created only under measured context pressure:

1. Measure the whole provider candidate, including system prompt, tool schemas,
   and prompt context.
2. Compact tool results when policy permits.
3. Apply deterministic bounded stream projection.
4. If pressure remains, ask Context Engine for a plan over a complete prefix of
   terminal runs before the protected current input.
5. Generate a structured summary with exact message-sequence anchors, allowing
   at most one repair, but do not commit it yet.
6. At adoption, revalidate the base/source and atomically commit the checkpoint
   and active pointer through Context Engine.
7. Replace the loop projection with the fresh commit response, then rebuild and
   measure checkpoint plus exact tail.

The default checkpoint estimate is 1,200 tokens. A checkpoint never grants
authority; every statement cites an exact retained message sequence. Failed or
unnecessary plans do not change durable state.

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
memory cards regenerate the compact snapshot used by later runs.

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
