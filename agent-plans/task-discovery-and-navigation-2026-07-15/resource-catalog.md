# Resource Catalog Plan

Created: 2026-07-15

Plan set: Task Discovery And Navigation

Status: proposed first foundation for task discovery. Not implemented by this
note.

## Problem

Ayati needs a reliable way to answer questions such as:

```text
Which task owns this file or directory?
Which task created or edited this deliverable?
Which tasks used this user attachment?
Where is the task that worked on a named resource?
Should a mutation continue an existing task or create a new task?
```

Task titles and recent usage are useful, but they are weaker than exact
resource identity. Files and directories created or mutated during a task are
strong evidence of task ownership. User attachments and other inputs are also
valuable search evidence, but they have different ownership semantics.

The Git Context Engine therefore needs a searchable resource catalog that
links durable resource identities to tasks and preserves mutation provenance.

## Goals

- Index files and directories created or mutated by the agent.
- Index files attached or explicitly selected by the user.
- Distinguish owned outputs, inputs, and read-only references.
- Resolve exact resources to task candidates without embeddings.
- Preserve enough provenance to explain every resource-to-task match.
- Update the catalog only from verified lifecycle events.
- Keep SQLite searchable and fast while Git remains canonical truth.
- Allow the index to be reconstructed from Git and durable run evidence.
- Support resources that exist before a task is selected.
- Preserve resource identity through rename, move, deletion, and reuse.

## Non-Goals

- Do not store full file contents in the resource metadata tables.
- Do not make SQLite a competing task-state authority.
- Do not treat every file read as owned by the reading task.
- Do not let a shared attachment create exclusive task ownership.
- Do not use resource recency alone to authorize mutation.
- Do not duplicate task repositories or task assets in virtual views.
- Do not require embeddings for resource or task lookup.

## Core Distinctions

### Resource origin

Origin describes how Ayati first learned about the resource:

```text
agent_created
user_attached
user_selected
externally_discovered
```

### Task relationship

Relationship describes how a particular task uses the resource:

```text
owned
    The task created or successfully mutated the resource and may continue to
    manage it.

output
    The resource is a user-facing deliverable of the task. An output will
    commonly also be owned.

input
    The user supplied or selected the resource as task input.

reference
    The task only inspected or consulted the resource.
```

These are not interchangeable. A task can own an output while several tasks
use the same attachment as an input or reference.

### Resource state

```text
active
moved
deleted
missing
```

Historical identity should remain searchable after a move or deletion. The
old resource must not remain an active mutation target.

## Recommended Data Model

Use separate resource identity and task relationship tables. A single file can
be linked to several tasks, especially when it is a shared user attachment.

### `resources`

One current row per stable resource identity:

```text
resource_id                 stable internal ID, primary key
kind                        file | directory
canonical_path              normalized absolute or canonical storage identity
workspace_relative_path     safe user-facing path when applicable
display_name                filename or directory name
extension                   normalized extension when applicable
mime_type                   detected or declared media type
content_hash                last verified content hash for files
size_bytes                  last verified size
origin                      agent_created | user_attached | user_selected |
                            externally_discovered
state                       active | moved | deleted | missing
storage_scope               task_repo | session_attachment | user_workspace |
                            external
created_at
updated_at
last_verified_at
```

Important indexes:

```text
unique normalized canonical_path for active resources where appropriate
content_hash
display_name
workspace_relative_path
state
origin
```

Do not assume that content hash alone is resource identity. Two different
files can intentionally have identical contents.

### `task_resources`

One relationship between a task and a resource:

```text
task_id
resource_id
relationship                owned | output | input | reference
first_seen_session_id
first_seen_run_id
last_touched_session_id
last_touched_run_id
first_verified_commit
last_verified_commit
created_by_tool
last_mutated_by_tool
mutation_count
last_used_at
relationship_status         active | superseded | detached
```

Recommended identity:

```text
task_id + resource_id + relationship
```

If implementation experience shows that a task needs several simultaneous
roles for one resource, either retain several relationship rows or replace the
single relationship field with a separate normalized role table. Do not hide
that distinction in an ambiguous JSON array without queryable indexes.

### `resource_aliases`

Keep old and user-facing identities searchable:

```text
resource_id
alias_type                  previous_path | user_label | attachment_name |
                            logical_name
alias_value
created_at
superseded_at
```

A rename should add the previous path as an alias rather than erasing it.

### Optional future `resource_search_fts`

SQLite FTS5 can index deterministic text such as:

- display name
- path components
- extension and MIME type
- attachment label
- previous path aliases
- user-provided description
- linked task title and confirmed task aliases

Full file content does not belong in this catalog. Content search can be a
separate, bounded fallback system later.

## Resources Before Task Selection

A user attachment can arrive before a task exists or before the correct task
has been activated.

The resource should first be associated with the session or pending turn:

```text
attachment received
-> persist attachment
-> create or update resource identity
-> record session/pending-turn association
-> do not claim task ownership
```

When routing resolves:

```text
existing task activated or new task created
-> link relevant attachment to task as input
-> retain the original session provenance
```

The attachment becomes owned only if the task later adopts and mutates a
durable copy as part of its deliverables. Merely reading it is insufficient.

## Deterministic Update Lifecycle

### User attachment

```text
user attaches file
-> persist bytes through the existing attachment lifecycle
-> calculate verified metadata and content hash
-> upsert resource
-> associate with session or pending turn
-> after routing, link to task as input
```

### Successful creation or mutation

```text
tool requests mutation
-> mutation authority resolves task and target
-> filesystem operation executes
-> deterministic verification succeeds
-> upsert resource metadata
-> create or update owned relationship
-> add output relationship when it is a declared deliverable
-> stamp run provenance
```

The model's requested path is not sufficient. Catalog changes representing
ownership must follow successful deterministic verification.

### Read-only access

```text
verified read succeeds
-> resource may be indexed or refreshed
-> link as reference only when durable task relevance is established
-> never create ownership from the read
```

Short-lived readContext and durable resource indexing have different
lifecycles. The catalog stores identity and provenance, not reusable full read
content.

### Task-run final commit

```text
task run reaches terminal finalization
-> task repository commits once for the completed run
-> reconcile verified resource changes
-> stamp affected task-resource rows with final task commit
-> refresh task search indexes and caches
```

Intermediate verified mutations may update live SQLite metadata for routing
and crash safety. The final task commit is the durable completed-history
anchor.

### Rename or move

```text
verified move succeeds
-> preserve stable resource_id when it is clearly the same resource
-> add old canonical path as previous_path alias
-> update current canonical path
-> update directory descendants deterministically when required
-> retain task relationship and provenance
```

### Delete or missing resource

```text
verified delete succeeds
-> mark resource deleted
-> keep historical relationships and aliases
-> remove it from active mutation candidates

expected resource is not found
-> mark missing after deterministic inspection
-> do not erase its history
```

## Search And Routing Use

The resource catalog should provide authoritative and explainable matches.

Example exact lookup:

```text
user asks to update workspace/aurora-coffee-site/styles.css
-> canonicalize target
-> exact resource match
-> find active owned relationship
-> return owning task and verified commit provenance
```

Example directory lookup:

```text
exact file is new but parent directory exists
-> find longest active owned-directory prefix
-> return owning task as strongest candidate
```

Example attachment lookup:

```text
user asks to continue the task that used website-requirements.md
-> match attachment name, hash, or alias
-> return all linked input/reference tasks
-> use task title, time, session, and status to rank candidates
-> ask when more than one candidate remains genuinely plausible
```

Search results should return reasons rather than only a numeric score:

```json
{
  "taskId": "W-20260714-0001",
  "matchAuthority": "exact_owned_resource",
  "matchReasons": [
    "Exact canonical path match",
    "Task owns the resource",
    "Ownership last verified at task commit 7f4bd105"
  ]
}
```

Suggested authority order:

```text
exact active owned file
-> longest active owned-directory prefix
-> exact task ID or repository identity
-> exact input/attachment relationship
-> exact filename or resource alias
-> lexical task and resource search
-> recent/frequent/starred reranking
-> clarification
```

Recency and frequency are discovery aids, not ownership proof.

## Git, SQLite, And Cache Responsibilities

### Git

- Stores actual task files and completed task history.
- Records the task commit that introduced, changed, moved, or deleted a
  resource.
- Provides durable evidence from which completed resource relationships can be
  reconstructed.

### SQLite

- Stores the fast current resource catalog.
- Stores session and pending-turn relationships for attachments.
- Stores task-resource links and verified provenance.
- Supports exact path, hash, filename, alias, and FTS lookup.
- Remains a rebuildable index rather than canonical task truth.

### In-memory cache

- Keeps hot path-to-resource and resource-to-task mappings.
- Caches recently queried attachment and ownership matches.
- Updates incrementally after verified lifecycle events.
- Invalidates affected entries on move, delete, relationship change, task
  finalization, or external freshness failure.
- Must never be the only place a durable relationship exists.

## Example

The user attaches:

```text
website-requirements.md
```

The agent creates:

```text
workspace/aurora-coffee-site/index.html
workspace/aurora-coffee-site/styles.css
workspace/aurora-coffee-site/app.js
```

Resulting relationships:

```text
website-requirements.md
    origin: user_attached
    relationship: input

index.html
    origin: agent_created
    relationships: owned, output

styles.css
    origin: agent_created
    relationships: owned, output

app.js
    origin: agent_created
    relationships: owned, output
```

The agent can later find the task through the attachment, any output filename,
the owned directory, the exact workspace path, or the final task commit.

## Required Invariants

- One resource has a stable identity independent of its task relationships.
- A shared input can link to many tasks.
- An owned mutable resource must not silently have conflicting task owners.
- Read-only access does not confer ownership.
- Ownership begins only after verified creation, mutation, or explicit adoption.
- Model claims never update authoritative resource metadata by themselves.
- Exact resource ownership outranks recency, frequency, and lexical similarity.
- Deleted and moved resources retain searchable historical identity.
- Internal task checkout paths are not exposed as user-facing resource paths.
- Task tools operate through verified task scope, not catalog paths supplied by
  the model.
- Git remains the canonical completed history; SQLite remains rebuildable.

## Implementation Slices

This is a future sequence, not implementation performed by this note:

1. Audit current attachment, task-placement, mutation-provenance, completion
   asset, and task-commit schemas.
2. Define canonical resource identity and path normalization contracts.
3. Add `resources`, `task_resources`, and `resource_aliases` migrations and
   repositories.
4. Index user attachments before task routing without claiming ownership.
5. Update the catalog after successful verified file and directory mutations.
6. Reconcile task-resource commit provenance during terminal task-run
   finalization.
7. Add exact resource and longest-directory-owner lookup APIs.
8. Add deterministic filename, alias, hash, and FTS search.
9. Add hot ownership and attachment lookup caches.
10. Integrate explainable resource matches into task search and routing without
    allowing weak matches to authorize mutation.
11. Add restart, rename, delete, shared-attachment, conflicting-owner, and
    cross-session live tests.
12. Only after this foundation is reliable, add recent, starred, frequent,
    virtual-directory, entity, timeline, and Git-fallback discovery systems.

## Open Design Questions

- Whether directories need explicit resource rows in every case or can be
  derived until a task explicitly owns the directory.
- How to represent a user file deliberately adopted into a task repository
  while retaining the original attachment identity.
- Whether simultaneous `owned` and `output` roles use separate relationship
  rows or a normalized resource-role table.
- Which metadata can be reconstructed exclusively from task commit trailers
  and which requires durable run evidence.
- How external files that Ayati may mutate are identified without exposing
  internal checkout paths or confusing user workspace identities.
- Which exact conflict policy applies when two tasks appear to own overlapping
  directory scopes.
- What minimal resource description should be generated for agent-created
  files and directories, and where that description belongs in the searchable
  index.
