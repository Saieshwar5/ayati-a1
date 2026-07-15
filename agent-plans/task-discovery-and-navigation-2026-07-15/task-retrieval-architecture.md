# Embedding-Free Task Retrieval Architecture

Created: 2026-07-15

Plan set: Task Discovery And Navigation

Status: synthesis design. It connects the resource catalog, task catalog, and
task-navigation views into one reliable discovery-to-activation system. It is
not implemented by this note.

## Purpose

Ayati must be able to find and continue the right task without requiring the
user to remember an exact task ID, repository, filename, or previous session.
The system should work for coding, research, learning, documents, planning,
email, databases, reminders, and other task types without embeddings.

The architecture should offer many independent ways to find a task while
preserving one canonical task identity and one verified activation boundary.

## Core Architecture

```text
canonical task repositories
        -> commit-derived task passports
        -> SQLite task and resource catalogs
        -> exact, lexical, timeline, entity, and activity indexes
        -> Agent Home navigation views
        -> deterministic task resolver
        -> explainable candidates
        -> verified activation handle
        -> task-scoped tools
```

Responsibilities remain clear:

```text
Git
    canonical task files and completed task history

SQLite
    rebuildable current indexes, relationships, activity projections, and
    search documents

service cache
    hot task cards, exact mappings, and prepared views

harness cache
    latest bounded agent-facing navigation projection

model
    uses visible evidence to choose among valid actions; it does not invent
    ownership or internal paths
```

## Primary Retrieval Rule

Do not calculate one unrestricted relevance score from every signal.

Use authority bands:

```text
authoritative identity
-> exact resource ownership
-> confirmed lexical identity
-> structured lexical retrieval
-> typo recovery
-> contextual reranking
-> Git fallback
-> clarification
```

An old exact owner must beat a recent but unrelated task. A starred task must
not beat a task that owns the requested file. Activity helps order candidates;
it does not create ownership.

## 1. Global Task Catalog

Every independent task repository receives one current searchable task card:

```json
{
  "taskId": "W-20260714-0001",
  "title": "Aurora Coffee website",
  "aliases": ["Aurora site", "coffee shop website"],
  "objective": "Build and maintain the Aurora Coffee website",
  "workStatus": "in_progress",
  "lifecycleStatus": "available",
  "categories": ["coding", "websites"],
  "tags": ["coffee", "html", "css", "javascript"],
  "ownedResources": ["workspace/aurora-coffee-site/"],
  "currentSummary": "Responsive coffee-shop website with menu and contact details.",
  "lastCommitSummary": "Added navigation and validated app.js.",
  "workingDirectory": "workspace/aurora-coffee-site",
  "lastUsedAt": "...",
  "activationCount": 6,
  "starred": false,
  "head": "7f4bd105"
}
```

This card is a materialized search projection, not task truth. Its `head` or
indexed revision must identify the exact task commit from which current state
was derived.

Do not place raw tool facts, all old commits, full conversations, or file
contents into this card. Those records remain in their authoritative stores.

Detailed table design belongs in:

```text
task-catalog.md
resource-catalog.md
```

## 2. Normalized Indexes

Reliability comes from several indexes that can agree or disagree visibly.

### Identity index

Index:

- exact task ID
- current normalized title
- confirmed aliases
- previous titles
- repository identity
- stable working-directory identity
- primary deliverable names

Exact ID and exact confirmed identity receive high authority.

### Resource index

Map typed resource identity to tasks:

```text
canonical resource identity
-> task relationship
-> ownership or reference authority
-> last verified task commit
```

For files and directories, use exact canonical paths and the longest active
owned-directory prefix.

Example:

```text
Task A owns workspace/aurora-coffee-site/
Task B owns workspace/gym-dashboard/

Request targets workspace/aurora-coffee-site/styles.css
-> Task A is the deterministic owner
```

Read-only files and shared user attachments remain input/reference evidence;
they do not create exclusive ownership.

### Full-text index

Use SQLite FTS5 over deliberately selected current text:

- title
- confirmed aliases
- objective
- current task-state summary
- current capabilities
- next action and open work
- categories, tags, technologies, and entities
- resource names and path components
- recent meaningful commit summaries
- deterministic command and error terms

FTS5 supplies BM25-style lexical ranking without embeddings.

### Timeline index

Support time-oriented requests:

```text
the website I worked on yesterday
last Tuesday's research
the task from this morning
what I worked on before the budget app
```

Index actual events:

```text
task mentioned
task activated
task mutated
task committed
task validated
task blocked
task completed
task archived
```

Search results and view display are not activity events.

### Entity index

Index concrete named entities:

- people
- companies
- products
- project names
- websites and domains
- technologies
- document names
- issue identifiers
- database and table names
- commands and error codes

Examples:

```text
Maria
-> invoice task and related email task

Aurora Coffee
-> website task

R_TOOL_INPUT_INVALID
-> agent reliability task
```

Entity matching is deterministic lexical retrieval, not semantic similarity.

### Activity index

Track:

- last mention
- last activation
- last verified mutation
- last commit
- activation count
- committed-run count
- session count
- time-decayed recent usage score

Actual task work counts. Searching for or displaying a task does not.

### Optional explicit relationship index

Later, store user-confirmed or deterministic task relations:

```text
parent
child
depends_on
related
supersedes
```

Shared weak keywords must not automatically create durable relationships.

## 3. Layered Search Pipeline

### Tier 1: authoritative lookup

Check:

- exact task ID
- explicit user-confirmed task selection
- exact canonical repository
- exact active owned resource
- longest active owned-directory match
- exact confirmed title or alias

A unique verified match may be activated automatically when it is compatible
with the current request.

### Tier 2: lexical retrieval

Search the FTS document using:

- user terms
- normalized punctuation and casing
- confirmed aliases
- path tokens
- task-state and capability terms
- recent meaningful task-commit text

Example:

```text
User: Continue the coffee website and make the menu warmer.

Task title: Aurora Coffee website
Alias: coffee shop website
Summary: responsive coffee-shop website with menu
```

The independent matches for `coffee`, `website`, and `menu` make the task a
strong lexical candidate.

### Tier 3: typo-tolerant recovery

Recover names such as:

```text
aurora coffe
-> Aurora Coffee website
```

Possible deterministic methods:

- trigram matching
- bounded edit distance
- prefix matching
- token overlap
- filename and path-component normalization
- case, whitespace, separator, and punctuation normalization

Fuzzy recovery retrieves candidates but does not independently authorize
mutation.

### Tier 4: contextual reranking

Rerank candidates using:

- mentioned in the current conversation
- current conversation focus trail
- used in the current session
- recently activated
- recently committed
- explicitly starred or pinned
- frequently used with time decay
- currently in progress
- matching requested category or resource type

These signals break ties within weaker retrieval bands. They never override an
exact task or owned-resource match.

### Tier 5: Git fallback

When the catalog is missing, stale, or inconclusive, search canonical task
repositories:

```text
task IDs, titles, and commit trailers
-> resource paths and changed-file history
-> Git commit messages
-> filenames
-> bounded textual repository content
```

Useful Git operations include conceptual equivalents of:

```text
git log --grep=<terms>
git log --all -- <path>
git grep <exact phrase> <commit>
```

This is a recovery layer rather than the normal request path because scanning
many repositories is more expensive than querying the catalog.

### Tier 6: clarification

If multiple plausible candidates remain, ask the user once using a compact
candidate list with reasons. Do not silently default to the most recent task.

## 4. Confirmed Aliases And User Vocabulary

Aliases are especially valuable without embeddings.

Example:

```json
{
  "title": "Aurora Coffee website",
  "aliases": [
    "coffee shop website",
    "Aurora site",
    "coffee website",
    "restaurant landing page"
  ]
}
```

Alias sources can include:

- explicit user naming
- user correction
- previous task title
- stable directory or deliverable name
- repeated successful routing phrase

Example correction:

```text
User: By the coffee site, I mean Aurora Coffee.
-> save `coffee site` as a confirmed alias for Aurora Coffee
```

Do not save every vague phrase after one model-selected route. Promote a phrase
when the user confirms it or repeated successful routing provides sufficient
deterministic evidence.

## 5. Resource Components As Search Terms

A path contains several useful identifiers:

```text
workspace/aurora-coffee-site/styles.css
```

Index:

```text
workspace
aurora
coffee
site
aurora-coffee-site
styles
styles.css
css
```

Also retain structured metadata:

```json
{
  "path": "workspace/aurora-coffee-site/",
  "kind": "directory",
  "state": "active",
  "relationship": "owned",
  "lastVerifiedCommit": "7f4bd105"
}
```

Ownership starts only after verified creation, mutation, move, or explicit
adoption. Read-only inspection does not create ownership.

## 6. Deterministic Task Fingerprints

A task fingerprint is an inverted set of concrete identifiers extracted from
verified current state and recent meaningful history.

Coding example:

```text
aurora
coffee
website
aurora-coffee-site
index.html
styles.css
app.js
javascript
node --check
responsive
menu
```

Research example:

```text
battery recycling
European Union
regulations
report.md
source domains
research dates
```

Possible fingerprint terms:

- resource names and extensions
- important document headings
- function, class, and package names
- commands and validators
- URLs and domains
- exact error signatures
- people and organizations
- user-confirmed vocabulary
- important terms from commit-derived task state

This enables searches such as:

```text
Find the task where node --check failed.
Find my task about European battery regulations.
Find the work containing styles.css and a menu.
```

Every fingerprint term should retain its kind and provenance so the resolver
can explain and weight it correctly.

## 7. Agent Home Personal Filesystem

Provide a human-like virtual filesystem of task references:

```text
agent-home/
├── desk/
│   ├── current/
│   ├── recently-used/
│   ├── waiting/
│   └── needs-attention/
├── starred/
├── sessions/
│   ├── today/
│   ├── yesterday/
│   └── this-week/
├── library/
│   ├── coding/
│   │   ├── ai-agents/
│   │   ├── websites/
│   │   └── mobile-apps/
│   ├── learning/
│   ├── research/
│   ├── documents/
│   └── personal/
├── people/
├── resources/
├── saved-searches/
├── completed/
└── archive/
```

Entries are task references or generated view results, not task repositories:

```json
{
  "taskId": "W-20260714-0001",
  "title": "Aurora Coffee website"
}
```

One task may appear simultaneously in:

```text
desk/recently-used/
starred/
library/coding/websites/
sessions/this-week/
resources/workspace/
```

The Git Context Engine resolves the task ID to the current repository and
commit. Virtual directories never define ownership or canonical location.

Detailed view behavior belongs in:

```text
task-views-and-navigation.md
```

## 8. Task Passport

Every task should have a compact passport derived from the latest indexed task
commit and normalized catalogs:

```json
{
  "taskId": "W-0001",
  "title": "Aurora Coffee website",
  "aliases": ["coffee website", "Aurora site"],
  "type": "coding",
  "workStatus": "in_progress",
  "objective": "Build and maintain the Aurora Coffee website",
  "resources": [
    {
      "kind": "directory",
      "identity": "workspace/aurora-coffee-site",
      "relationship": "owned"
    }
  ],
  "entities": ["Aurora Coffee"],
  "technologies": ["HTML", "CSS", "JavaScript"],
  "currentCapabilities": [
    "Menu section",
    "Contact details",
    "Responsive layout"
  ],
  "openWork": [],
  "lastActivity": "...",
  "head": "7f4bd105"
}
```

The passport is the search and navigation representation. It must not become a
manually maintained task-state file.

## 9. Routing Corrections And Negative Evidence

Remember wrong matches as well as successful ones.

Example:

```text
User: Update the coffee website.
Agent candidate: Gym dashboard.
User: No, I mean Aurora Coffee.
```

Record:

```json
{
  "phrase": "coffee website",
  "confirmedTask": "W-0001",
  "rejectedTasks": ["W-0007"],
  "source": "user_correction"
}
```

Useful negative evidence includes:

- rejected task candidates
- resources explicitly stated not to belong to a task
- superseded or invalid aliases
- user corrections
- similar tasks that must remain separate
- type conflicts such as website versus mobile application

Negative evidence should have provenance and lifecycle. A correction must not
become an unexplained permanent ban if the underlying task identity later
changes.

## 10. Conversation Focus Trail

Humans use references such as:

```text
that one
continue it
go back to the previous project
the other website
use the same task as before
```

Maintain a small focus trail:

```json
{
  "focusTrail": [
    {
      "taskId": "W-0001",
      "reason": "explicitly activated",
      "conversationPosition": 42
    },
    {
      "taskId": "W-0007",
      "reason": "mentioned",
      "conversationPosition": 35
    }
  ]
}
```

This is browser-like back/forward context, not a permanently active task.

Focus entries can result from:

- explicit selection
- task activation
- explicit task mention
- successful follow-up resolution
- returning from another task

The focus trail is a contextual reranking and pronoun-resolution signal. It
does not independently authorize mutation.

## 11. Small Desk And Large Library

Do not inject the complete task catalog into every prompt.

### Desk

A small agent-visible working set:

- current-run task, if any
- tasks mentioned in the current conversation
- up to five recent tasks
- relevant starred tasks
- a few tasks needing attention
- current matching candidates

### Library

The full searchable catalog, available through task search and Agent Home
browsing.

### Archive

Tasks intentionally excluded from normal results but retained for explicit
search and recovery.

```text
Desk = immediate recognition and continuity
Library = complete searchable task collection
Archive = durable but normally hidden work
```

This reduces prompt size, accidental selection, and repeated catalog scans.

## 12. Explainable Search Results

Every candidate should explain why it matched:

```json
{
  "candidates": [
    {
      "taskId": "W-0001",
      "title": "Aurora Coffee website",
      "confidence": "high",
      "matchAuthority": "confirmed_alias",
      "matchedBy": [
        "Confirmed alias: coffee website",
        "Entity: Aurora Coffee",
        "Current state matched: menu",
        "Used two days ago"
      ]
    },
    {
      "taskId": "W-0007",
      "title": "Coffee ordering mobile app",
      "confidence": "medium",
      "matchAuthority": "lexical",
      "matchedBy": [
        "Text matched: coffee",
        "Type conflict: user requested website"
      ]
    }
  ]
}
```

Match authority and reasons are more useful than one unexplained numeric score.
Numeric details may still be retained for observability and live-test tuning.

## 13. Separate Search From Activation

Task discovery and task activation are different operations:

```text
search_tasks
    read-only; returns candidates and evidence

activate_task
    verifies the selected task, repository, head, resource scope, and session
    mount before task work begins
```

Routing policy:

```text
unique authoritative match
-> activate automatically after verification

strong lexical match with a clear candidate gap
-> activate only under a tested confidence policy and record reasons

several plausible candidates
-> ask the user once

no suitable candidate for durable mutation
-> create a new task
```

Critical invariant:

```text
Never default a mutation to the most recent task merely because no better
match was found.
```

## 14. Verified Activation Handle

Finding the correct task is insufficient if tools can still operate on the
wrong root. Successful activation should return an opaque handle:

```json
{
  "taskHandle": "TH-93f2",
  "taskId": "W-0001",
  "title": "Aurora Coffee website",
  "head": "7f4bd105",
  "resourceScope": "workspace/aurora-coffee-site",
  "contextRevision": 18
}
```

Mutation tools use the handle and task-relative targets:

```json
{
  "taskHandle": "TH-93f2",
  "path": "styles.css"
}
```

The harness and Git Context Engine resolve actual paths. The model should not
construct internal submodule or checkout paths.

Before mutation, verify:

- handle is valid for the current run
- task ID and repository still agree
- task HEAD has not unexpectedly changed
- target resolves relative to the task working root
- target lies within authorized task scope
- no different task owns the target

This prevents correct discovery followed by incorrect execution.

## 15. Incremental Index Maintenance

Update at deterministic lifecycle boundaries:

```text
task created
-> index identity, repository, working directory, initial commit, and aliases

task activated
-> update real usage and focus trail

verified mutation
-> update live resource and activity projections

terminal task-run commit
-> update current task state, resources, commit summary, fingerprint, FTS,
   views, and cache revision

task renamed or corrected
-> update current title and preserve old title as alias

user correction
-> update confirmed alias and negative routing evidence

task archived
-> remove from normal views while preserving searchability
```

Do not rebuild every task for every request. Reindex the affected task and
refresh only affected cache entries and views.

## 16. Generic Resource Types

File ownership is the strongest initial signal, but the resource abstraction
should support other task types:

```json
{"kind": "file", "identity": "workspace/report.md"}
{"kind": "directory", "identity": "workspace/aurora-coffee-site"}
{"kind": "git_repository", "identity": "customer-api"}
{"kind": "url", "identity": "https://example.com/research"}
{"kind": "database", "identity": "sales/orders"}
{"kind": "email_thread", "identity": "thread-123"}
{"kind": "calendar_event", "identity": "event-456"}
{"kind": "issue", "identity": "project/issue-72"}
```

Every resource kind needs:

- stable canonical identity
- relationship to the task
- current state
- verification source
- last verified task commit or external revision when applicable

Files and directories remain the MVP priority.

## Recommended MVP

Build the smallest reliable cross-section:

1. Global SQLite task catalog with indexed Git HEAD.
2. Exact task ID, confirmed title, and alias matching.
3. Canonical file and directory ownership index.
4. SQLite FTS5 over compact current task data.
5. Typo-tolerant title and alias recovery.
6. Recent, starred, frequent, status, and session reranking.
7. Explainable candidates with match authority.
8. Separate search and activation operations.
9. Verified activation handle and task-relative mutation paths.
10. Incremental indexing after terminal task-run commits.
11. Small Desk projection and full searchable Library.
12. Git history fallback before final user clarification.

After live tests validate the MVP, add:

- deterministic task fingerprints
- timeline and entity indexes
- routing corrections and negative evidence
- user vocabulary learning
- smart Agent Home collections
- explicit task relationships
- generic non-file resource adapters

No embedding system is required for this architecture.

## Success Criteria

- Exact file and directory requests always locate the verified owning task.
- Confirmed aliases reliably find tasks across sessions.
- Recent and frequent views never override exact ownership.
- Follow-up phrases such as "that one" resolve through the conversation focus
  trail or trigger clarification.
- Task search returns reasons that feedback reports can audit.
- A stale catalog cannot activate a task without Git HEAD reconciliation.
- The model never needs internal task checkout paths.
- The agent can find coding and non-coding tasks through typed resources,
  entities, activity, and task state.
- The default prompt remains bounded when thousands of tasks exist.
- A catalog miss escalates to Git search and then clarification rather than an
  unrelated recent task.

## Final Principle

```text
A task should have many ways to be found,
one canonical identity,
and exactly one verified activation boundary before work begins.
```
