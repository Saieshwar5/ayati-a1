# Context and Memory

Ayati separates stream continuity, current-run execution, durable work,
resources, reusable observations, and personal memory. They have different
growth rates and different authority.

## Ownership

- Context Engine SQLite V7: agent streams, immutable messages, runs, steps,
  WorkState, checkpoints, reusable observations, workstreams, requests,
  resources, discovery indexes, isolated workstream-resolution activities and
  steps, idempotency, and recovery journals.
- Workstream Git: compact portable `workstream.md`, request files, and
  `resources.json` only.
- Real resource locations: project files, documents, media, URLs, databases,
  repositories, and external objects.
- Personal memory: stable, evolving, and time-scoped facts about the user.
- Episodic memory: semantic recall over prior experience.
- Active-run projection: the harness keeps the latest authoritative service
  response for the current turn; it does not maintain a second context cache.

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

Workstream resolution is a separate bounded control activity keyed to the
same run. It has private state, full private step history, limits, and usage
accounting. It cannot update main WorkState or append `run_steps`; its terminal
typed result is committed by Context Engine and then mounted into the main
projection. An unfinished activity is marked interrupted on restart and is
not resumed.

## Agent-Facing Prompt Lanes

The model receives an explicit bounded projection:

- `context.temporal`: durable checkpoint and exact recent message tail;
- `context.current`: current input sequence/run identity and routing state; the
  exact input content appears once in `context.temporal.recent`;
- `context.stream`: stream identity and recent work references;
- `context.work`: at most five candidates, compact resolution metadata, and
  the optional single active workstream/request;
- `context.resources`: stream, ingress, and active-workstream resources;
- `context.observations`: valid reusable inventory/discovery/evidence;
- `context.personal`: compact personal-memory snapshot;
- `context.tools`: current capability surface;
- `context.harness`: compact repair feedback;
- `context.run`: WorkState, current-run calls, and pressure state.

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

## Durable Pressure Checkpoints

Checkpoints are created only under measured context pressure:

1. Measure the whole provider candidate, including system prompt, tool schemas,
   and prompt context.
2. Compact tool results when policy permits.
3. Apply deterministic bounded stream projection.
4. If pressure remains, ask Context Engine for a plan over a complete prefix of
   terminal runs before the protected current input.
5. Generate a structured summary with exact message-sequence anchors, allowing
   at most one repair.
6. Atomically commit the checkpoint and active pointer.
7. Rebuild and measure the checkpoint-plus-exact-tail candidate.

The default checkpoint estimate is 1,200 tokens. A checkpoint never grants
authority; every statement cites an exact retained message sequence. Failed or
unnecessary plans do not change durable state.

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
and recent run evidence before lower-value projections. If the final bounded
candidate remains inadmissible, the run ends as `incomplete/context_limit`.

Startup closes an abandoned safe run as `incomplete/interrupted`. Journaled
finalizations and resource operations resume idempotently. Unresolved recovery
blocks another run in the same agent stream.
