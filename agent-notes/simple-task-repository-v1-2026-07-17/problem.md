# Problem

## Product Problem

Ayati is intended to help with work that naturally outlives one conversation:

- learning a subject over many days
- building and maintaining software
- using browsers and applications for multi-step computer work
- repeating or extending data analysis
- developing and operating automations
- using a computer to complete evolving real-world work

The user should not need to understand session boundaries, context windows,
task branches, memory layers, or run-storage placement. They should be able to
return to a durable task and continue.

The current meaning of "task" is too close to a finite unit of work. That does
not fit a website that receives later features or a learning journey with an
unknown end. If every bounded improvement becomes a new task, continuity is
fragmented. If the entire workstream becomes `done`, reopening becomes a
special case. If sessions own the context, the user must remember which session
contained the relevant work.

## Context Fragmentation

Useful task truth is currently distributed across combinations of:

- task repository trees and commit messages
- bare canonical task repositories
- stable working checkouts
- session submodule checkouts and gitlinks
- SQLite operational rows and caches
- session conversation and run evidence
- generated task summaries or historical task-branch files
- stable docs that still describe older and newer architectures together

Each representation may be defensible in isolation, but the combination makes
creation, continuation, recovery, and explanation harder.

The simplest question should have a simple answer:

```text
What is the current state of this task?
-> read its task card, active request, and recent Git history
```

It should not require reconstructing the answer from a session repository,
submodule pointer, SQLite catalog, several generated files, and commit trailers.

## Repository Duplication

The current independent-context migration can represent one task in three
physical places:

```text
bare canonical repository
stable user-facing working checkout
session-owned submodule checkout
```

This requires coordination across:

- repository creation
- checkout creation and verification
- pushes to the bare repository
- submodule creation and branch attachment
- gitlink updates
- task HEAD cache updates
- session commits
- cross-repository recovery phases

That machinery primarily preserves an exact session-level Git snapshot. It is
not required merely to reopen, read, continue, or version a task.

## Task And Request Conflation

The system needs two durable concepts, not one overloaded concept:

```text
task = persistent workstream
request = bounded desired change, lesson, analysis question, or improvement
```

Examples:

```text
Task: Coffee website
Requests: build initial site, add reservations, improve accessibility

Task: Learn machine learning
Requests: study linear regression, practice classification, build a project
```

Without this distinction, Ayati either creates too many repositories or treats
normal future work as reopening a supposedly completed object.

## Status Conflation

Task, request, and run statuses answer different questions:

- Task status: should this durable workstream remain available for work?
- Request status: what is the state of one bounded user intention?
- Run outcome: what happened in one execution attempt?

Using `done`, `blocked`, or `active` interchangeably across all three produces
incorrect routing and confusing continuation behavior.

## Attachment Durability Problem

The user wants attachments and mentioned references available inside the task,
but does not want raw attachment bytes tracked by ordinary Git.

This creates an important boundary:

```text
ignored file = locally available, not Git durable
tracked manifest = durable provenance, not proof that bytes still exist
```

The system needs to preserve this distinction. It must record identity,
checksum, source, availability, and adoption without pretending an ignored file
can be restored from task history.

The name `public/` is unsuitable because many application frameworks treat it
as deployable public content. Private user inputs should live under the
Ayati-owned namespace instead.

## Recovery Problem

Directly mutating a normal task repository is simple only if interruptions are
handled deliberately. Ayati must distinguish:

- a clean task still at the expected base commit
- a completed task commit whose final journal acknowledgement was interrupted
- verified but uncommitted changes
- unexpected or unverified dirty paths
- external user commits or edits made while Ayati was inactive

No recovery path may silently reset, stash, discard, or commit unknown work.

## Desired Outcome

The target system should make this normal:

```text
create one durable task repository
receive many bounded requests over time
read any task whenever useful
lock only when mutation begins
commit one verified result per mutating run
close Ayati
return days later
read task.md + active request + Git history
continue without session management
```

## Problems This Plan Intentionally Does Not Solve Yet

This plan does not attempt to perfect:

- discovery across thousands of tasks
- semantic similarity search
- remote synchronization
- multi-writer collaboration
- long-term binary attachment backup
- automatic adoption of arbitrary existing Git repositories
- organization through virtual folders or categories

Those systems should be built on top of a small reliable task contract, not
designed into the contract before it is proven.
