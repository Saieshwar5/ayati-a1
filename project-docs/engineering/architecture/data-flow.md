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
The daemon maps them into temporal, current, stream, work, resources,
observations, personal, tools, harness, and run prompt lanes.

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
tool calls, verification, and resulting WorkState. Successful list/search/read
calls may also create resource-versioned reusable observations.

## Pressure and History

The compiler measures the whole provider candidate. Stable deduplication,
invalid-observation removal, recoverable tool-result projection, and
deterministic bounds run before semantic recovery. A durable checkpoint is
generated without mutation and commits only after adoption validation; its
fresh Context Engine projection replaces the loop projection. If durable
recovery is insufficient, a 1,600-token anchored focus overlay may replace
only covered older prompt material for the rest of that run.

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
resource effects, reduces workstream context when needed, and creates at most
one context commit. Deliverables are not staged in workstream Git.

Only then does the daemon send the terminal response envelope.

## Memory

Committed checkpoint ranges feed personal-memory extraction asynchronously.
Personal memory remains independent from stream continuity; episodic memory
remains an explicit semantic-recall system.

## System Events

Plugins and Pulse normalize events through `SystemIngressService` and
`SystemEventWorker`. System events enter the same default agent stream and use
the same run, step, pressure, and finalization lifecycle as user messages.
