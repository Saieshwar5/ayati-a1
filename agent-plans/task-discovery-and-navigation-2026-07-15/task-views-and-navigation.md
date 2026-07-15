# Task Views And Navigation Plan

Created: 2026-07-15

Plan set: Task Discovery And Navigation

Status: proposed navigation and sorting layer. Not implemented by this note.

## Core Idea

Ayati should navigate tasks in a way similar to how people use a computer:

- Recent items make unfinished work easy to resume.
- Starred items preserve explicit user importance.
- Frequent items surface habitual work.
- Status views separate active, blocked, completed, and archived work.
- Categories and custom collections make a large task library browsable.

Do not physically move or copy task repositories into organizational folders.
Create lightweight views over the same canonical task identities.

```text
Git task repositories = canonical task contents and completed state
SQLite task catalog = searchable task metadata and view inputs
in-memory cache = hot prepared navigation views
task navigator = compact model-facing projection and browsing API
```

One task may appear in several views without duplication.

## Why Views Are Needed

Humans rarely remember every exact filename, project name, or directory. They
find work through several forms of recognition:

```text
I worked on it yesterday.
I starred it.
It is the project I use most often.
It was blocked.
It is one of my AI-agent projects.
It owns this directory.
It was created in today's session.
```

Task views give the agent the same retrieval paths without requiring the model
to inspect every repository or receive every task in its prompt.

## Standard Views

### Recent

Tasks most recently activated or worked on.

Primary sort:

```text
last meaningful use descending
```

Meaningful use includes activation, verified task work, or a completed task
run. Merely returning a task in search results does not count.

### Recently changed

Tasks whose repositories most recently received a terminal task-run commit.

This is different from Recent. A task may have been activated or discussed
without receiving a new commit.

### Starred

Tasks explicitly starred by the user.

Starred is durable user organization. The agent must not silently star a task
because it appears important or frequently used.

### Pinned

An optional smaller view for tasks the user wants permanently visible near the
top of the navigator. Pinning and starring may begin as one MVP feature unless
live tests show a real need for both.

### Frequent

Tasks repeatedly activated and worked on, ordered by a time-decayed usage
score.

Do not use a lifetime counter alone. Otherwise an old once-popular task can
remain permanently above current work.

Conceptually:

```text
frequent score =
    strong weight for recent committed runs
  + strong weight for recent verified mutation
  + normal weight for recent activation
  + small weight for recent task follow-up
  + decayed contribution from older activity
```

Searching, listing, or merely displaying a task contributes nothing.

### In progress

Tasks whose latest commit-derived work status is `in_progress`.

### Needs attention

Tasks with an actionable problem, including:

- blocked work
- failed validation
- incomplete terminal outcome
- unresolved user input requirement
- repository or catalog reconciliation failure

The view should explain the reason. It must not combine all problems into an
unexplained warning badge.

### Completed

Tasks whose latest commit-derived work status is `done`.

Completed tasks remain searchable and may be reopened by a later run. Done is
not the same as archived.

### Archived

Tasks intentionally removed from normal navigation and default search.

Archived tasks remain durable and explicitly searchable. Archiving must not
delete their repository or task history.

### By category

Browse tasks through deterministic or user-confirmed categories:

```text
Coding
Learning
Research
Documents
Personal
Communication
Planning
```

Categories should remain small and general. More precise information belongs
in tags, technologies, entities, resources, and custom collections.

### By resource

Browse tasks through files, directories, repositories, attachments, and other
typed resources.

Examples:

```text
By resource / Workspace / aurora-coffee-site
By resource / Attachment / website-requirements.md
By resource / Repository / ayati-a1
```

Owned resources provide stronger routing evidence than input or reference
resources. See `resource-catalog.md`.

### Related tasks

Tasks connected through explicit relationships, shared non-exclusive inputs,
parent/child structure, or user-confirmed association.

Do not infer a durable related-task graph from one weak word overlap.

### Session tasks

Tasks created, activated, mutated, or committed in a selected session:

```text
Current session
Previous session
Session by date
```

This helps with requests such as "continue the task from yesterday's
session."

### Custom collections

User-created groups such as:

```text
AI Agents
Important
This Week
Learning / Active
Client Work
```

A custom collection can be either:

```text
static collection
    explicit list of task IDs

smart collection
    saved deterministic query over task metadata
```

## Smart Collections As Virtual Folders

Virtual folders should be saved queries, not physical task locations.

Examples:

```text
Recent
    order by last_activated_at descending

Frequent
    order by recent_usage_score descending

Starred
    starred = true

Coding / AI Agents
    category = coding AND tag = ai-agent

Learning / Active
    category = learning AND work_status = in_progress

Needs Attention
    work_status = blocked OR validation = failed OR latest_outcome = incomplete
```

Conceptual saved-view shape:

```json
{
  "viewId": "learning-active",
  "name": "Learning/Active",
  "kind": "smart",
  "filters": {
    "category": "learning",
    "workStatus": "in_progress"
  },
  "sort": [
    { "field": "lastActivatedAt", "direction": "desc" }
  ]
}
```

The same task may appear in Recent, Starred, Learning/Active, and This Week.
Only one canonical task repository exists.

## Search And Routing Authority

Views make task discovery easier, but sorting must not authorize mutation.

Use this authority order:

```text
1. explicit task ID or explicit user-confirmed task selection
2. exact active owned file/directory or repository identity
3. exact confirmed task title or alias
4. current-run task when the request clearly continues that run
5. exact attachment or input relationship
6. lexical title, objective, summary, tag, and resource match
7. recent, starred, frequent, session, and status reranking
8. optional future semantic retrieval only if deterministic search proves
   insufficient
```

Important qualifications:

- Starred means important, not necessarily relevant to the current request.
- Recent means recently used, not necessarily owned by the request.
- Frequent means habitual, not authorized.
- A unique exact resource owner outranks all three.
- An explicit user selection can authorize activation after the selected task
  and repository identity are verified.
- Mutation still requires the normal verified task scope and authority.

The current intended system does not require embeddings. Optional semantic
retrieval remains deferred and must not be needed for the MVP.

## Simple Task Index Projection

The underlying normalized tables are defined in `task-catalog.md` and
`resource-catalog.md`. A combined task card may look like:

```json
{
  "taskId": "W-20260714-0001",
  "title": "Aurora Coffee website",
  "aliases": ["coffee website", "Aurora site"],
  "workStatus": "in_progress",
  "lifecycleStatus": "available",
  "starred": true,
  "categories": ["coding", "websites"],
  "tags": ["coffee", "html", "css", "javascript"],
  "ownedResources": ["workspace/aurora-coffee-site/"],
  "createdAt": "...",
  "lastActivatedAt": "...",
  "lastCommittedAt": "...",
  "activationCount": 6,
  "recentUsageScore": 4.8,
  "head": "7f4bd105"
}
```

This is a search and navigation projection, not canonical task state.

## Agent-Facing Navigation Context

Do not inject every task or every view into the model context.

Provide a compact navigator:

```json
{
  "taskNavigation": {
    "revision": "nav-42",
    "currentRunTask": null,
    "recent": [
      {
        "taskId": "W-001",
        "title": "Aurora Coffee website",
        "workStatus": "in_progress",
        "lastUsed": "today"
      }
    ],
    "starred": [],
    "needsAttention": [],
    "matchingCandidates": []
  }
}
```

Recommended limits for the initial version:

```text
recent                at most 5
starred               at most 5 relevant or most recently used
needs attention       at most 5
matching candidates   at most 5
```

The full catalog remains available through search and browse operations.

## Service And Cache Responsibilities

### Git Context Engine

- Own normalized task metadata and saved view definitions.
- Compute deterministic view membership and sorting.
- Record meaningful task activity events.
- Maintain time-decayed frequent scores.
- Build compact task cards and navigation projections.
- Return match reasons and source revisions.
- Refresh affected views after task lifecycle changes.

### Service-side cache

Keep hot prepared views such as:

- Recent
- Recently changed
- Starred
- Frequent
- Needs attention
- Current-session tasks

Update only affected task cards and views after activation, verified mutation,
final commit, star change, archive change, or metadata correction.

### Harness-side cache

Keep the latest service-provided navigation projection and its revision. The
harness should not independently calculate usage scores or rebuild view
membership.

## View Update Lifecycle

```text
task created
-> add to Recent, Recently changed, In progress, and Current session

task activated
-> update Recent and Frequent inputs

verified mutation occurs
-> update live usage input; do not claim completed task state

task-run commit succeeds
-> update Recently changed, status views, Needs attention, session view,
   Frequent inputs, and relevant smart collections

user stars or unstars task
-> update Starred immediately

task validation fails
-> add to Needs attention with reason

task becomes done
-> move between In progress and Completed views without moving repository

task archived
-> remove from normal views and expose through Archive
```

## Initial APIs Or Tools

The exact transport can be HTTP through the typed Git Context Engine client.
Conceptual operations are:

```text
list_task_views
browse_task_view(viewId, limit, cursor)
search_tasks(query, filters, limit)
star_task(taskId, starred)
save_task_collection(definition)
delete_task_collection(viewId)
```

Search, listing, and browsing are read-only. Star and custom-collection changes
require explicit user intent or a clearly authorized deterministic harness
action.

Task activation remains separate:

```text
discover candidate
-> inspect match reasons
-> activate verified task
-> receive task handle and current context
-> allow task work
```

## Reliability Invariants

- Views contain task references, never copied task repositories.
- One task may appear in many views while retaining one canonical identity.
- Search and view display do not increase usage counts.
- Starred is explicit user metadata, not inferred importance.
- Frequent uses time decay rather than lifetime count alone.
- Completed and archived remain distinct.
- Needs Attention always includes a reason.
- Recent, Frequent, and Starred never authorize mutation by themselves.
- Exact verified resource ownership outranks view ranking.
- Default agent context remains bounded even when the task library is large.
- User-created organization must have a durable source, not exist only in an
  in-memory cache.
- Every navigation projection carries a revision for cache synchronization.

## MVP

Start with:

1. Exact resource ownership from the resource catalog.
2. Recent tasks.
3. Recently changed tasks.
4. Explicit Starred tasks.
5. Frequent tasks with basic time decay.
6. In progress, blocked/needs-attention, completed, and archived views.
7. Title, confirmed alias, tag, and category search from the task catalog.
8. Current-session tasks.
9. A compact top-candidate navigation projection.
10. Explainable discovery followed by separate verified activation.

Add custom smart collections, related-task graphs, deeper timeline browsing,
and optional semantic retrieval only after live tests show the MVP needs them.

## Success Examples

```text
User: Continue the file-indexing task from yesterday.
-> Session/Recent view plus lexical match returns the correct task.

User: Open my starred AI-agent task.
-> Starred plus category/tag filter returns candidates.

User: Update coffee-shop/index.html.
-> Exact owned resource selects the owning task regardless of Recent ranking.

User: Show unfinished learning tasks.
-> Learning/Active smart view returns only matching tasks.

User: What needs my attention?
-> Needs Attention returns blocked or failed-validation tasks with reasons.
```

## Final Principle

```text
Git stores canonical tasks.
SQLite indexes and organizes them.
The cache exposes small useful views.
Views help the agent discover candidates.
Verified identity and ownership decide where work may happen.
```
