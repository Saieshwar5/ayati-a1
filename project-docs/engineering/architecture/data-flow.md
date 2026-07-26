# Data Flow

## Ingress and Run Preparation

1. A client sends a user message or an integration emits a normalized system
   event.
2. The daemon calls `prepareAgentRun` with `agentId`, `scopeKey`, role, content,
   resources, and a stable request id.
3. One transaction resolves or creates the agent stream, appends the immutable
   ingress message, creates one run and initial WorkState, and stores the
   idempotency receipt.
4. Replay returns the same stream, message, run, and context projection. A
   competing active run rolls back atomically.

## Context Projection and Decision

The service returns slow stream continuity and fast run context separately.
The daemon maps them into core, hot, tools, harness, and run prompt lanes.
Authoritative workstream details and resource cards are not model-facing lanes
or Hot Context sources. Hot Context initially contains catalog metadata only.
A transient `context.retrieve` decision may mount one or more advertised
entries for the rest of that run. `workstreams.recent` is
prepared from creation/open/binding metadata and remains absent from the prompt
until loaded. It is navigation context only; current workstream state still
requires an authoritative read. One recent-document registry is rebuilt from
at most 32 verified successful complete historical reads from stable terminal
runs. A paused or failed responsibility does not invalidate an earlier
successful read; running and recovery-required runs remain excluded. Its five
newest lightweight pointers are always visible in
`core.current.activeDocuments`; only the older 27 records are mountable through
`files.recent`. Both carry navigation metadata so a same-file follow-up can
skip rediscovery; current contents still require one read. `workstates.recent`
is
rebuilt from the existing terminal run and WorkState rows. It advertises at
most five material historical handoffs and mounts their summaries, plans,
important context, next actions, sequence references, and optional workstream
identity only when the model explicitly loads the key. It creates no duplicate
persistence and grants no current authority or completion evidence.

One runtime-owned context-preparation manager is created for the run. Before a
primary decision it builds a typed lane manifest, validates any ready
source-hashed candidate against the current exact tail, measures the whole
serialized request, and may start one disposable background preparation job.
The manager is not an agent and exposes no model-facing tool.

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

An unbound run may reply, list, read, search, inspect resources, or route. A
workstream routing control binds the existing run and returns refreshed
context; the model then makes a fresh decision.

Each executor step persists one ordered record containing decision, action,
tool calls, and verification. It does not revise WorkState. Older tool
evidence stays in that exact run journal and is searched on demand rather than
copied into a second cross-run context record. Sparse WorkState checkpoints
are separate named events for planning, context pressure, terminal handoff,
and exact-request continuation. After final validation passes, terminal
handoff deterministically promotes at most four selected passed outcomes into
compact important-context receipts with exact run/step/call references.

## Pressure and History

The compiler measures the whole provider candidate. Recoverable tool-result
projection runs before semantic recovery. A durable checkpoint is generated
without mutation and commits only after adoption validation; its fresh Context
Engine projection replaces the loop projection. If durable recovery is
insufficient, a 1,600-token anchored focus overlay may replace only covered
older prompt material for the rest of that run.

Older content is recovered explicitly with `agent_history_search` and
`agent_history_read`; it is not copied into every prompt.

## Workstreams and Resources

Workstream candidates come from deterministic catalog discovery. Exact
resource ownership and explicit continuation outrank text, unfinished, star,
recency, and frequency signals. Real operations run against resource locators,
never the context repository.

## Finalization

The daemon calls `finalizeRun` and waits for acknowledgement. Context Engine
appends the immutable assistant message, closes the run, records verified
resource effects, persists the terminal WorkState and its bounded validation
receipts, reduces workstream context when needed, and creates at most one
context commit. Deliverables are not staged in workstream Git.

Only then does the daemon send the terminal response envelope.

## Memory

Committed checkpoint ranges feed personal-memory extraction asynchronously.
Personal memory remains independent from stream continuity; episodic memory
remains an explicit semantic-recall system. Its compact snapshot is a
rebuildable `personal.memory` Hot Context source, not an always-included prompt
lane.

## System Events

Plugins and Pulse normalize events through `SystemIngressService` and
`SystemEventWorker`. System events enter the same default agent stream and use
the same run, step, pressure, and finalization lifecycle as user messages.
