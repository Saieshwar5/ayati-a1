# SQLite Task Catalog Plan

Created: 2026-07-15

Plan set: Task Discovery And Navigation

Status: proposed second foundation for task discovery. Not implemented by this
note.

## Decision

Ayati should keep a rich, searchable catalog of tasks and task metadata in the
Git Context Engine's SQLite database.

This is not a replacement for task repositories or task-state commits:

```text
task repository and commits = canonical completed task truth
SQLite task catalog = current searchable projection of that truth
in-memory cache = hot task-navigation projection
```

The catalog should contain enough current, structured, and explainable data to
find a task quickly. It should not copy all raw Git history, conversations,
tool inputs, tool outputs, or file contents into one task row.

## Why This Is Needed

Git is excellent for durable history, but searching every task repository and
parsing every commit for each user request is unnecessarily slow. The agent
also needs queries that Git alone does not naturally answer efficiently:

```text
show recently used unfinished tasks
find the task called the coffee site
find tasks that used a particular attachment
show starred learning tasks
find the task last worked on Tuesday
find tasks with failed validation
find the task that owns a workspace directory
```

SQLite can answer these questions quickly through exact indexes, relational
joins, FTS5, and deterministic sorting. Git remains available to verify a
result and as a deeper fallback search source.

## Current Implementation Snapshot

The current `tasks` table already stores a useful minimal registry:

```text
task_id
repository_path
working_path
durable_branch
head_sha
title_cache
objective_cache
status                  initializing | active | archived
created_session_id
created_at
updated_at
```

Current task search performs a case-insensitive substring search over:

```text
title_cache
objective_cache
working_path
```

Results are ordered by `updated_at`.

The current task commit also provides a compact persistent state:

```text
Task-Id
Task-Title
Task-State
Task-Status             in_progress | done | blocked
Validation
Next
Run
Session
Run-Outcome
```

The task context reader derives current task context by reading Git paths and
recent commits. This is the correct source model, but the useful derived data
is not yet materialized into a complete search catalog.

Important current gaps include:

- no aliases or previous titles
- no tags, categories, technologies, or named entities
- no indexed current task-state summary
- no separate operational and work status in search results
- no indexed validation health or next action
- no starred or user-created organization metadata
- no reliable activation, mutation, and commit usage statistics
- no resource ownership and attachment relationships
- no recent commit search index
- no FTS5 task document
- no explainable match reasons
- no negative routing corrections
- no task relationship graph

### Existing SQLite sources to reuse

Useful data already exists outside the `tasks` table:

```text
runs and run_steps
    task binding, timing, step count, tool purpose, outcome, and verification

run_work_state
    run-local summary, open work, blockers, facts, evidence, artifacts, and
    next step

task_run_finalizations
    terminal outcome, cumulative summary, validation, next action, completion
    assets, final response, and final Git provenance

conversation_segments and messages
    task-linked user language and conversation history

task_mutation_authorities and checkpoint transactions
    verified targets, created/modified/deleted/renamed provenance, purposes,
    and staged paths

session_task_mounts
    repository, working path, branch, mounted head, and mount lifecycle
```

These tables are authoritative ledgers for their own events. The task catalog
should select and materialize only their useful current discovery signals. It
should not duplicate their raw JSON or full histories.

The current tables also lack practical discovery indexes such as task and time
indexes over completed runs and finalizations. Catalog implementation should
add only the indexes required by measured query paths rather than repeatedly
scanning these ledgers.

## Fundamental Status Distinction

Do not overload one `status` column.

Ayati has two different state dimensions:

```text
catalog lifecycle status
    initializing | available | archived

task work status
    in_progress | done | blocked
```

A completed task is still available and searchable. An archived task may have
finished or unfinished work. These dimensions must remain separate.

## Data Design Principle

Keep the existing `tasks` table as the stable task and repository registry.
Store changing and multi-valued search metadata in focused tables.

Avoid this design:

```text
tasks.metadata_json = every task fact, resource, tag, commit, and statistic
```

It is hard to index, update, explain, and reconcile. Use normalized tables for
exact relationships and one generated FTS document for lexical retrieval.

## Recommended Tables

### 1. Existing `tasks` registry

Continue using the current table for stable identity and repository state:

```text
task_id
repository_path
working_path
durable_branch
head_sha
title_cache
objective_cache
lifecycle_status
created_session_id
created_at
updated_at
```

The existing `status` column can be renamed in a breaking development
migration or treated as `lifecycle_status` at the contract boundary.

The title and objective are caches of current Git-derived identity, not a
second canonical source.

### 2. `task_state_index`

One current commit-derived task-state projection per task:

```text
task_id                         primary key
indexed_head_sha                task commit used to build this row
state_version                   parsed task-state commit version
work_status                     in_progress | done | blocked
current_summary                 compact current task/product state
next_action                     nullable continuation action
validation_status               passed | failed | not_run
latest_outcome                  done | incomplete | failed | blocked |
                                needs_user_input
latest_run_id
latest_session_id
latest_conversation_id
latest_task_commit
latest_task_committed_at
indexed_at
```

`indexed_head_sha` is critical. It proves exactly which Git state the SQLite
projection represents and makes stale-index detection deterministic.

### 3. `task_aliases`

Store searchable alternate identities:

```text
alias_id
task_id
alias
normalized_alias
source                           user_confirmed | previous_title |
                                 working_directory | repeated_route
status                           active | superseded | rejected
created_at
last_confirmed_at
```

User-confirmed aliases are stronger than automatically derived aliases.
Previous titles remain searchable. A vague phrase should not become a durable
alias after one accidental match.

Useful uniqueness:

```text
task_id + normalized_alias + status
```

### 4. `task_terms`

Use one normalized table for deterministic classifications and fingerprint
terms:

```text
task_id
term
normalized_term
term_kind                        category | tag | technology | entity |
                                 deliverable | command | error_signature
source                           user | task_commit | resource | validation |
                                 deterministic_extractor
status                           active | superseded
created_at
updated_at
```

Examples:

```text
category          coding
technology        JavaScript
entity            Aurora Coffee
deliverable       website
command           node --check
error_signature   Unexpected token function
```

Do not mix model guesses with confirmed metadata without recording the source.

### 5. `task_user_preferences`

Store user-controlled organization separately from derived task state:

```text
task_id
starred
pinned
hidden
user_rank                       nullable explicit ordering
updated_at
```

Starred and pinned are explicit user choices. The agent must not star a task
merely because it is frequently used.

This metadata is not naturally reconstructable from task repository history.
If SQLite must remain completely rebuildable, a later Agent Home or navigator
Git repository should durably record user organization and rebuild this table.
Do not silently pretend a SQLite-only star is recoverable from task commits.

### 6. `task_usage_stats`

Materialize inexpensive sorting data:

```text
task_id
last_mentioned_at
last_activated_at
last_mutated_at
last_committed_at
activation_count
committed_run_count
session_count
recent_usage_score
score_updated_at
```

Usage events should have different weight:

```text
task committed       strong usage
task mutated         strong usage
task activated       normal usage
task mentioned       weak contextual signal
task returned by search
                     no usage
```

`recent_usage_score` should decay over time. A lifetime count alone would keep
an old once-popular task permanently above newer relevant tasks.

The score is a sorting aid, never ownership proof.

### 7. `task_commit_index`

Index recent meaningful task commits for fast historical discovery:

```text
task_id
commit_sha
committed_at
subject
task_state_summary
work_status
validation_status
run_outcome
run_id
session_id
is_current
```

Git remains the complete history. SQLite only needs the useful searchable
projection, such as the latest state plus a bounded number of recent meaningful
commits. A Git search can handle deep-history recovery.

### 8. Resource catalog tables

Use the companion resource plan:

```text
resources
task_resources
resource_aliases
```

These tables provide the strongest task-search evidence:

```text
exact owned resource
-> owning task
```

Attachments provide input/reference matches without falsely claiming
ownership.

### 9. Optional future `task_relations`

Explicit non-embedding task relationships can improve discovery:

```text
from_task_id
to_task_id
relationship                    parent | child | depends_on | related |
                                supersedes
source                          user | deterministic
created_at
```

This is not required for the first catalog MVP.

### 10. `task_search_fts`

Build one generated SQLite FTS5 document per current task from:

- current title
- confirmed aliases and previous titles
- objective
- current task-state summary
- next action
- categories, tags, technologies, and entities
- active resource names and path components
- attachment names
- recent meaningful commit subjects
- deterministic error and command terms

The FTS row should contain current searchable text, not become a new source of
truth. Rebuild it from the normalized tables whenever the catalog revision for
that task changes.

## Data That Should Not Be Copied Into The Task Catalog

Keep these in their existing authoritative stores:

```text
full task files                     task Git repository
complete task commit history       Git
full conversations                 conversation/session persistence
raw tool inputs and outputs        run step ledger
complete verification evidence     run evidence records and files
full reusable read content         readContext/run records
binary attachment contents         attachment storage
```

The catalog can reference these records and index their stable identifiers.
It should not duplicate their payloads.

## Deterministic Update Lifecycle

### Task creation

```text
task repository successfully initialized
-> insert stable tasks registry row
-> index title, objective, working directory, and initial head
-> create initial task_state_index from the creation commit
-> create initial FTS document
-> increment catalog revision
```

### Task activation

```text
task selected and repository/head verified
-> update last_activated_at and activation_count
-> update session_count when this is a new session/task pair
-> refresh hot recent-task views
```

Searching or listing a task must not count as activation.

### Verified mutation during a run

```text
verified mutation succeeds
-> update live resource catalog and last_mutated_at
-> do not invent a new completed task state before final commit
```

### Terminal task-run finalization

The most important transaction boundary is:

```text
task run finishes for any terminal reason
-> final task commit succeeds
-> parse the exact committed task-state message
-> update tasks.head_sha
-> replace task_state_index for that head
-> reconcile resource and commit indexes
-> update usage statistics
-> rebuild that task's FTS document
-> increment catalog revision
-> update service cache
```

All SQLite projections must identify the same final task commit.

If Git commit succeeds and SQLite update fails, startup or request-time
reconciliation compares `tasks.head_sha`, repository HEAD, and
`task_state_index.indexed_head_sha`, then reindexes that task. The agent should
not receive a mixed projection from different commits.

### Rename or identity correction

```text
task title changes in a committed task state
-> update title cache
-> preserve previous title as an alias
-> rebuild FTS document
```

### Star, pin, or custom organization change

```text
explicit user action
-> update user preference source
-> update SQLite projection
-> refresh relevant virtual views
```

These changes should not create a task-work commit unless they also change the
task itself.

### Archive

```text
explicit archive policy succeeds
-> lifecycle_status = archived
-> retain task work status and full search metadata
-> exclude from default results
-> include when archived search is requested or no live candidate matches
```

## Search Pipeline

Do not combine every signal into one unrestricted score. Use authority bands:

```text
1. exact task ID or canonical repository
2. exact active owned resource or longest owned-directory prefix
3. exact confirmed title or alias
4. exact attachment/input relationship
5. FTS5 lexical retrieval
6. typo-tolerant title and alias recovery
7. status, session, starred, recency, and frequency reranking
8. Git history or content fallback search
9. user clarification
```

Within a band, activity and user preferences can order candidates. A recent
unrelated task must never beat an exact resource owner.

## Search Result Contract

Return compact candidates with evidence:

```json
{
  "taskId": "W-20260714-0001",
  "title": "Aurora Coffee website",
  "workStatus": "in_progress",
  "lifecycleStatus": "available",
  "currentSummary": "Responsive coffee-shop website with menu and contact details.",
  "workingDirectory": "workspace/aurora-coffee-site",
  "head": "7f4bd105",
  "confidence": "high",
  "matchAuthority": "confirmed_alias",
  "matchReasons": [
    "Confirmed alias matched: coffee site",
    "Current task state contains: menu",
    "Task was committed in the current week"
  ]
}
```

Numeric scores may be included for debugging, but the harness should reason
from authority and match reasons rather than an unexplained number.

## Agent Context And Cache

Do not place the entire task catalog in every model prompt.

The Git Context Engine should prepare a small navigation projection:

```text
current-run task, if any
tasks mentioned in the current conversation
top recent tasks
top starred tasks
tasks needing attention
query-matching candidates
```

The service cache should hold:

- task ID to current compact task card
- exact normalized title and alias mappings
- hot resource-to-task mappings
- recent/starred/needs-attention views
- current task catalog revision

The harness cache should hold the latest received projection and revision, not
reconstruct task metadata independently.

Every deterministic catalog update increments or replaces the relevant
revision so only affected task cards and views need refresh.

## Reliability Invariants

- Every indexed task state names the exact Git commit it represents.
- Git and SQLite never act as competing completed task-state authorities.
- Operational lifecycle status and task work status remain separate.
- Search results never expose internal task submodule checkout paths.
- Exact task or resource identity outranks recency and frequency.
- Search/list events do not inflate usage statistics.
- User-starred and user-confirmed metadata is distinguishable from derived
  metadata.
- A stale catalog head triggers reconciliation before task activation.
- Archived tasks remain searchable when explicitly requested.
- Raw run evidence and file contents are not copied into the task catalog.
- A task catalog match does not authorize mutation until task activation and
  resource scope are verified.
- Every automatically selected task records match authority and reasons for
  feedback and live-test auditing.

## MVP Implementation Slices

1. Preserve the existing `tasks` table as the stable registry and make the two
   status meanings explicit in contracts.
2. Add `task_state_index` keyed by task and indexed Git HEAD.
3. Populate it from the final task-state commit after every terminal task run.
4. Add `task_aliases`, including confirmed aliases and previous titles.
5. Add `task_usage_stats` with honest activation and commit events.
6. Integrate the resource catalog's exact ownership and attachment joins.
7. Add `task_search_fts` over current compact task data.
8. Replace substring-only search with authority-banded exact, resource, alias,
   FTS, and reranking stages.
9. Return match reasons and catalog/head revisions.
10. Add service-side hot task-card and navigation-view caches.
11. Add reconciliation when repository HEAD and indexed HEAD disagree.
12. Add full runtime and live tests for exact resource, alias, recent, blocked,
    completed, archived, shared attachment, typo, and ambiguous-task searches.

After the MVP proves reliable, add task terms, durable user collections,
timeline views, negative routing corrections, task relationships, virtual
directories, and Git deep-search fallback.

## Open Design Questions

- Which task-state fields should be added to future commit schema versions
  without making commit messages too large?
- Where should durable user organization such as starred tasks live so it can
  rebuild SQLite without polluting task repositories?
- How many recent task commits should be materialized for normal FTS before
  falling back to direct Git search?
- Which task terms may be generated deterministically and which require user
  confirmation?
- Should a completed task be slightly deprioritized for new work, or should
  exact identity always present it normally and let the request decide?
- What confidence-gap rule permits automatic activation after lexical search?
- How should explicit negative routing corrections be represented and expire?
- Which catalog fields should be included in the always-hot agent navigation
  context versus returned only by task search?
