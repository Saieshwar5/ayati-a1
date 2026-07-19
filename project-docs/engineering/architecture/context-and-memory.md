# Context and Memory

Ayati separates operational truth, durable work continuity, user memory, and
prompt projection.

## Ownership

- Git Context SQLite: sessions, conversations, runs, steps, WorkState,
  workstreams, requests, resources, bindings, discovery indexes, idempotency,
  and recovery journals.
- Workstream Git: compact portable `workstream.md`, request files, and
  `resources.json` only.
- Real resource locations: project files, documents, media, URLs, databases,
  repositories, and external objects.
- Personal memory: stable facts, preferences, and time-scoped facts about the
  user.
- Episodic memory: semantic recall over prior closed experience.
- Daemon cache: bounded projections only; never authoritative lifecycle state.

## Session Continuity

A daily session groups conversation and operational history. It does not own
durable work. Every accepted message or system event creates one run
atomically with its message and initial WorkState. Direct replies are valid
zero-step runs.

Optional session materialization is evidence and debugging support, not the
source of workstream truth.

## Workstream Continuity

A workstream is selected only when the current run has clear durable ownership.
It carries objective, current focus, request state, progress, blockers, next
action, and resource relationships. Later runs reconstruct continuity from the
catalog and committed context rather than from a session-global active item.

Resource identity is part of recall. Exact path/URL/external-object ownership
can locate a workstream even when its title or user wording changes.

## Requests and Runs

Requests bound a concrete intention inside one long-lived workstream. At most
one request is active. Activating an existing workstream explicitly continues
that request or creates a separate request.

A run may begin unbound, perform observation, and later bind to one
workstream/request without changing its run id. Binding is immutable. The next
user answer or event creates a new run.

## Prompt Projection

The prompt receives a bounded projection, not raw database rows or internal
paths.

- `context.session`: recent conversation, compact summary/checkpoints,
  attachments, and relevant activity.
- `context.git.candidates`: explained workstream candidates.
- `context.git.current`: selected workstream/request and public resource
  locators when bound.
- `context.git.ingressResources`: resources admitted for the current turn.
- `context.readContext`: reusable inventory, discovery, evidence, and action
  entries derived from persisted run steps.
- `context.run`: WorkState, ordered current-run tool calls, and context pressure.
- `context.personal`: selected personal and episodic memory.
- `context.tools`: current capability surface.
- `context.harness`: compact repair information.

Run ids, storage paths, context-repository paths, runtime mode names, routing
counters, and deferred mutation state are not model-facing prompt data.

## Reusable Read Context

```text
readContext = {
  revision,
  afterCommitRunId?,
  inventory,
  discovery,
  evidence,
  actions
}
```

Entries are rebuilt from authoritative structured run steps. Current-run tool
calls are not duplicated in reusable context. A newly created
workstream-context commit resets the reusable window; no-change, failed,
unbound, and skipped finalizations do not.

## Resources and Attachments

Attachments are admitted before routing. Uploaded bytes use immutable managed
storage and a public managed-blob identity. Referenced resources stay at their
canonical path. Both can remain session-only or be bound to a workstream.

Descriptions and aliases make resources searchable without parsing every file
on every turn. Version observations detect changed, missing, or deleted
resources; they do not turn SQLite into a content backup.

## WorkState

WorkState is the sparse current-run progress projection: status, summary, open
work, blockers, verified facts, evidence, and optional user-input need. The
progress reducer updates it only from deterministic execution/verification.
Workstream finalization reduces durable continuity from the final WorkState and
accepted completion evidence.

## Personal and Episodic Memory

Personal memory is independent from workstreams. A preference may influence
many workstreams without belonging to any one of them. Episodic recall supplies
relevant prior experience but does not grant resource access or mutation
authority.

## Context Pressure

Token admission is deterministic and measured. The runtime trims lower-value
reusable/context-history material before exact current input, current
workstream/request/resource ownership, recent steps, and WorkState. If safe
admission is still impossible, the run finalizes as
`incomplete/context_limit`; it does not silently discard ownership facts.

## Recovery

Startup closes an abandoned safe run as `incomplete/interrupted`. Journaled
finalizations and resource operations resume idempotently. Verified dirty
resource state is preserved and unresolved recovery blocks another run in the
same session.
