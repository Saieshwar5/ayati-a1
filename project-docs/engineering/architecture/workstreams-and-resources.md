# Workstreams and Resources

This page is the canonical description of Ayati's durable-work model.

## Mental Model

```text
workstream = long-lived continuity for one coherent body of work
request = one bounded intention inside a workstream
run = one compute, audit, and recovery boundary for one accepted event
resource = a real file, directory, URL, dataset, database, repository, or external object
agent stream = slow continuity across many runs and clients
```

A website, learning journey, recurring research topic, maintained automation,
or ongoing administrative goal is normally one workstream. Later features,
lessons, investigations, and improvements become requests in that workstream.

Users do not need to create, name, sort, or reopen workstreams manually. The
agent searches and selects them from durable evidence. If ownership is
ambiguous before mutation, it asks one focused question.

## One Ayati Root

`AYATI_ROOT_DIR` owns the complete managed topology:

```text
<ayati-root>/
  workspace/                 default user-visible output location
  workstreams/               context-only Git repositories
    W-YYYYMMDD-NNNN-<slug>/
      .git/
      workstream.md
      requests/
        R-NNNN-<slug>.md
      resources.json
  .ayati/
    context.db               authoritative catalog and run journals
    resources/               immutable managed attachment bytes
```

If the user gives no destination, Ayati creates output under
`<ayati-root>/workspace/`. If the user names an existing path, the resource
stays at that path. Workstream context and user-visible output are never mixed.

## Context-Only Workstream Repositories

Each `W-*` directory is an independent normal Git repository, but it contains
only compact UTF-8 continuity data:

- `workstream.md`: title, objective, status, summary, current focus, blockers,
  and next action.
- `requests/*.md`: bounded requests and their acceptance state.
- `resources.json`: portable resource references, roles, access, aliases, and
  descriptions.

Deliverables, source trees, media, downloads, databases, and user files must
not be copied into workstream Git. The repository validator rejects unexpected
tracked or untracked output files. Git history therefore records how the
workstream context changed, not a duplicate project history.

The service renders and commits these reserved files. General tools receive no
mutation access to a workstream context repository.

## Resources

The resource catalog is the shared identity layer for agent streams and
workstreams. A resource has:

- a stable `RES-*` identity;
- a kind and origin;
- a real locator (`filesystem`, managed blob, URL, or external provider);
- a human-readable display name, AI-generated description, and aliases;
- availability and version observations;
- at most one canonical binding per workstream with a stable role, access, and
  primary-resource status;
- zero or more request-specific roles that record how individual requests used
  the resource without duplicating workstream ownership.

Supported kinds include files, directories, documents, images, audio, video,
datasets, databases, Git repositories, URLs, and external objects. Origins
distinguish user attachments and references from agent-created, discovered,
or downloaded resources.

Resources are useful in both directions:

```text
workstream -> resources needed for continuation
resource -> workstreams that own or reference it
```

This makes exact path ownership one of the strongest continuation signals. It
also lets the agent find a forgotten workstream from a document, repository,
URL, or output directory.

Resource metadata in SQLite supports identity, filtering, sorting, and search.
The context repository keeps the richer portable ledger humans and agents can
read directly. Neither store embeds the resource bytes except managed user
attachments.

`workstream_resources` therefore has one row per workstream and resource.
Reusing a primary directory as completion evidence updates its last-use facts
and records the request relationship; it does not add a second `deliverable`
workstream binding. The portable `resources.json` ledger likewise contains
each resource identity once.

## Attachments

Ingress attachments are admitted as resources before routing. User-uploaded
bytes are copied once into `.ayati/resources/` using content-addressed,
immutable storage; a managed-blob locator exposes identity without leaking the
private storage path into prompts. Referenced files remain at their canonical
path.

An attachment can remain stream-scoped, become a workstream input or reference,
or help discover an existing workstream. Workstream Git records metadata and
relationships only.

## Discovery and Selection

The main model sees one ownership control: `workstream_resolve`. It supplies a
concise purpose and optional exact workstream, resource, filesystem, or URL
hints. Hints improve the resolver's starting point but never grant ownership
or mutation authority.

An isolated resolver activity owns the discovery tools. It searches and reads
workstreams, checks resource owners, inspects a new locator when needed, and
then activates one workstream, creates one workstream, or publishes one
clarification. Its state and complete journal are separate from main run steps
and WorkState. The main loop waits for the activity and receives only a typed
metadata receipt; the selected workstream/request context arrives through the
fresh authoritative Context Engine projection.

The main prompt sees the result in one bounded lane:

```text
context.work = {
  candidates: WorkstreamCandidate[]       // zero to five; empty once bound
  resolution?: {
    activityId, runId, status, purpose, stepCount, result?, updatedAt
  }
  active?: {
    workstreamId, title, objective, summary, currentRequest, resources, ...
  }                                       // exactly one when bound
}
```

`workstream_resolve` returns only receipt metadata such as activity, status,
selected workstream/request ids, private step count, and context revision. The
authoritative workstream content is read from `context.work.active`, not
duplicated into the tool result.

Candidate ordering is deterministic and explained. Exact identity, resource
ownership, and explicit unfinished-request continuation are strongest. Text
relevance, unfinished state, explicit stars, recency, and frequency organize
the remaining catalog. A star is a user preference, never mutation authority.

Reading a candidate does not bind the run. The resolver's terminal create or
activate operation binds the already-prepared run; it never allocates another
run. Once bound, the workstream/request identity is immutable. At most five
recent/relevant candidates are mounted while unbound, and only the single
active workstream is mounted after binding.

Activating an existing workstream requires an explicit choice:

- continue its exact active request; or
- create a new request for a materially separate outcome in the same
  workstream.

A recent workstream never silently owns the current turn.

## Run Capabilities

Every accepted user message or system event creates one run atomically.

- An unbound run may converse and use safe observational tools. Actionable
  ownership resolution runs through the isolated resolver.
- A workstream-bound run may use resources according to their declared access.
- Mutation without a binding is rejected with a stable repair code.
- Binding refreshes context; the model then makes a fresh mutation decision.
  Mutation calls are never deferred or replayed.

One run may observe first and bind later without changing its run id. Resolver
steps remain in their own journal and do not become task-step or completion
evidence.

## Exact Resource Mutation

Mutation authority is separate from workstream ownership. Before a mutating
tool runs, the daemon resolves every target against the bound resources and
the service records exact pre-mutation observations. Directory resources allow
contained descendants; file resources allow only that file. Read-only
resources cannot be mutated.

The service rejects path escapes, unsafe symlinks, ambiguous resource owners,
unbound calls, cross-resource targets, unknown mutation effects, and stale
operations. After execution it observes the same targets again and records a
verified mutation result or recovery state.

Tool output alone is not mutation truth. Deterministic verification and the
before/after resource observations are authoritative.

## Finalization

Finalization has three independent operational results:

1. assistant-message append and run closure;
2. verified resource effects;
3. an optional workstream-context commit.

A successful workstream finalization reduces the latest request, progress,
blockers, next action, and resource ledger, then creates at most one context
commit. It never stages or commits deliverables. A read-only continuation with
no context change returns `not_required`; a reduction that produces identical
context returns `no_change`.

The terminal response envelope is sent only after finalization is durably
acknowledged. A dirty context repository, mismatched HEAD, unverified resource
operation, or uncertain commit identity produces failure or
`recovery_required`, never a false success.

Reusable observations are resource-versioned and remain available while their
sources are relevant. Workstream commits do not erase unrelated stream
observations.

## Recovery

SQLite journals run finalization and resource mutation operations for
idempotent restart recovery. A running run with no mutation or finalization
journal closes as `incomplete/interrupted`. Verified dirty resource changes
are never deleted automatically. An unresolved mutation recovery state blocks
another run in the same agent stream until safety is restored.

Catalog rebuild scans only validated context repositories. It reconstructs
workstream and resource relationships from their committed context, but
operational preferences such as stars and access counts are not reconstructible
from Git.

## Git Boundaries

Ayati does not initialize Git for ordinary output. A user's project may already
be a Git repository, may be non-Git, or may be an external location. Project
version control remains the user's or the relevant tool's responsibility and
is activated only when explicitly requested.

The context repository's commit history supplies durable continuity even when
the real output has no Git history. Completion summaries and version
observations describe what changed without pretending that context Git can
revert the real-world resource.

## Primary Source Paths

- `ayati-context-engine/src/contracts.ts`
- `ayati-context-engine/src/resources/`
- `ayati-context-engine/src/workstreams/`
- `ayati-context-engine/src/services/resource-catalog-service.ts`
- `ayati-context-engine/src/services/resource-mutation-service.ts`
- `ayati-context-engine/src/services/workstream-lifecycle-service.ts`
- `ayati-context-engine/src/services/workstream-discovery-service.ts`
- `ayati-context-engine/src/services/workstream-binding-service.ts`
- `ayati-context-engine/src/repositories/workstream-resolution-records.ts`
- `ayati-context-engine/src/services/workstream-finalization-service.ts`
- `ayati-main/src/app/resource-scoped-tool-executor.ts`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-main/src/ivec/agent-runner/workstream-binding-capability-policy.ts`
- `ayati-main/src/ivec/workstream-resolution/`
- `ayati-main/src/skills/builtins/git-context/`
