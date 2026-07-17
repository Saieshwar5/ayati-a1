# Task Repository Contract

## Canonical Layout

Every new V1 task begins with:

```text
<task-root>/<task-id>-<slug>/
  .git/
  .gitignore
  .ayati/
    task.md
    requests/
      R-0001-<slug>.md
    references.md
    inbox/
      .gitkeep
```

The first request may be omitted only when the task is deliberately created as
an empty user-managed workstream. Normal agent-created durable work should
create the initial request atomically with the task.

Project-specific files live beside `.ayati/` using their natural structure.

## Ownership

### Engine-owned tracked files

```text
.ayati/task.md
.ayati/requests/*.md metadata, status, and outcome sections
.ayati/references.md
required .gitignore entry for .ayati/inbox/
```

The Git Context Engine writes these during creation and finalization. General
tools cannot mutate them.

### Task-owned files

Everything else inside the repository is ordinary task content. Examples:

- source code
- tests
- reports
- notebooks
- learning notes
- exercises
- automation definitions
- user-approved tracked inputs

### Local ignored inputs

`.ayati/inbox/` contains local user-provided bytes managed by the attachment
lifecycle. It is readable when available but excluded from normal commits.

## `.gitignore`

The initial file contains at least:

```gitignore
# Ayati local input bytes. Durable provenance lives in .ayati/references.md.
.ayati/inbox/*
!.ayati/inbox/.gitkeep
```

Task-specific tools may append domain ignore rules through normal verified
work. They must preserve the inbox rule.

## Task Card Schema

Path:

```text
.ayati/task.md
```

Format: UTF-8 Markdown with a small YAML-style frontmatter contract. The V1
parser should support only the required scalar/list shapes; it does not need a
general YAML feature set.

Template:

```markdown
---
schema: ayati.task/v1
id: T-20260717-0001
title: Learn machine learning
status: active
current_request: R-0002
---

# Learn machine learning

## Purpose

Build a practical understanding of machine learning through explanations,
exercises, implementations, and small projects.

## Current snapshot

Linear regression fundamentals and the first NumPy implementation are complete.

## Current focus

Practice logistic regression and evaluate it on a classification dataset.

## Blockers

None.

## Important paths

- `notes/linear-regression.md` - completed concept notes
- `exercises/linear-regression.py` - verified implementation

## Working agreements

- Prefer practical examples followed by concise mathematical explanations.
```

### Required frontmatter

```text
schema
id
title
status
current_request
```

`current_request` is either one request ID or `none`.

Do not store `updated_at` or HEAD in the task card. Git already owns commit
identity and time; duplicating them creates noisy self-referential updates.

### Task statuses

```text
active
paused
archived
```

- `active`: available for normal continuation.
- `paused`: preserved but no work is currently expected.
- `archived`: explicitly retired from normal views; still readable and
  reopenable.

Task status does not describe whether the latest run succeeded or whether one
request is blocked.

### Required sections

- `Purpose`: stable reason the workstream exists.
- `Current snapshot`: cumulative verified current state.
- `Current focus`: immediate bounded direction, usually aligned with the
  current request.
- `Blockers`: durable current blockers or `None.`
- `Important paths`: small curated list, not a full file tree.
- `Working agreements`: durable task-specific constraints and preferences.

### Size and content rules

- Target fewer than 150 lines and fewer than 8,000 characters.
- Use concise current facts.
- Do not include raw tool output, full conversation, full commit history,
  secrets, transient errors, or speculative claims.
- Never claim work or validation that deterministic evidence did not support.
- Remove obsolete snapshot details when they no longer help continuation; Git
  retains the history.
- Keep at most roughly 20 important paths. Retrieve more on demand.

## Request File Schema

Path:

```text
.ayati/requests/R-0002-practice-logistic-regression.md
```

Request IDs are monotonically allocated within one task:

```text
R-0001
R-0002
R-0003
```

The filename slug is descriptive but identity comes from frontmatter.

Template:

```markdown
---
schema: ayati.request/v1
id: R-0002
status: active
created_at: 2026-07-17T10:30:00+05:30
source: user
---

# Practice logistic regression

## Request

Explain logistic regression, implement it from scratch, and complete one
classification exercise.

## Acceptance

- Explanation is recorded.
- Implementation runs successfully.
- Exercise results are evaluated.
- Important misunderstandings are noted.

## Constraints

- Use Python and NumPy before introducing a framework.

## Outcome

Not completed yet.
```

### Required request frontmatter

```text
schema
id
status
created_at
source
```

V1 sources:

```text
user
agent_proposal
imported
```

An `agent_proposal` is not automatically active. It begins `queued` and must
remain distinguishable from an accepted user request.

### Request statuses

```text
queued
active
blocked
done
dropped
```

- `queued`: durable request accepted or retained for later.
- `active`: current work is attempting to satisfy it.
- `blocked`: cannot progress until a named condition changes.
- `done`: acceptance criteria are satisfied or explicitly accepted.
- `dropped`: intentionally abandoned, rejected, or superseded.

At most one request is `active` in V1. A task may have many queued or blocked
requests. `task.md.current_request` must match the single active request or be
`none`.

### Request mutation rules

- Preserve the meaning of `Request` and `Acceptance` after work begins.
- Clarifications may refine acceptance criteria in a normal commit, but must
  not silently weaken the user's original intent.
- Record supersession or cancellation in `Outcome`; do not delete historical
  request files.
- Blocking the active request clears `task.md.current_request` and records a
  task-card blocker that names the request. Resuming it restores the pointer
  only when no other request is active.
- Mark `done` only after acceptance is deterministically verified or the user
  explicitly accepts a non-machine-verifiable result.
- A later correction normally receives a new request. Reopen the old request
  only when it is genuinely the same unfinished intention.

## References Manifest

Path:

```text
.ayati/references.md
```

This tracked file records task-relevant inputs without storing ordinary raw
bytes in Git.

Template:

```markdown
# References

## REF-0001

- Kind: attachment
- Label: housing-data.csv
- Location: `.ayati/inbox/REF-0001-housing-data.csv`
- SHA-256: `sha256:...`
- Availability: available
- Added: 2026-07-17T10:35:00+05:30
- Requests: R-0001
- Adopted path: none
- Notes: User-provided source dataset; preserve original bytes.

## REF-0002

- Kind: external_path
- Label: existing dashboard
- Location: `/home/user/projects/dashboard`
- SHA-256: unavailable
- Availability: unchecked
- Added: 2026-07-17T10:40:00+05:30
- Requests: R-0002
- Adopted path: none
- Notes: Read-only reference unless the user explicitly imports it.
```

V1 kinds:

```text
attachment
external_file
external_directory
url
task_path
```

Availability:

```text
available
missing
changed
unchecked
```

Rules:

- Allocate stable `REF-NNNN` IDs within the task.
- Store checksums for local files when practical.
- Do not store secrets, access tokens, or private URL credentials.
- Absolute external paths are allowed as local provenance but are not portable
  and are never task-owned mutation authority.
- A shared attachment may appear in multiple task manifests without granting
  exclusive ownership.
- `Adopted path` points to a tracked task-relative path only after an explicit
  adoption operation.
- The manifest is evidence about an input, not proof the bytes still exist.

## Inbox Contract

Path:

```text
.ayati/inbox/
```

Rules:

- Contents are ignored by normal Git status and commits.
- Names begin with the stable reference ID to avoid collisions.
- The attachment service writes inbox files atomically.
- General task tools may read them but do not overwrite originals.
- Deletion follows an explicit retention policy, never ordinary task cleanup.
- Task cloning does not restore inbox bytes.
- Before using an inbox file, the runtime validates existence and checksum when
  recorded.

## Adopting An Input

When an ignored or external input must become reproducible task content:

```text
user or accepted plan requests adoption
-> validate source availability and checksum
-> choose a normal task-owned destination
-> copy bytes without modifying the original
-> verify the copy
-> update Adopted path in references.md
-> commit the adopted file with the current run
```

Do not automatically track every attachment. Large, private, licensed, or
temporary data may remain local.

## Commit Contract

### Initial identity commit

Subject:

```text
create machine learning task
```

Body/trailers:

```text
Task: T-20260717-0001
Request: R-0001
Outcome: created
Ayati-Schema: task/v1
Ayati-Event: task_created
```

The initial commit contains the complete standard scaffold and initial request.

### Final mutating-run commit

Subject is a short lowercase imperative or outcome description grounded in the
verified work:

```text
implement logistic regression exercise
```

Required trailers:

```text
Task: T-20260717-0001
Request: R-0002
Run: RUN-20260717-0042
Session: S-20260717-local
Outcome: completed
Validation: passed
Ayati-Schema: task/v1
Ayati-Event: task_run_finalized
```

Optional trailers:

```text
Next: evaluate regularization
Conversation-Id: C-...
Conversation-Hash: sha256:...
```

Allowed final outcomes:

```text
completed
incomplete
blocked
failed
```

Validation:

```text
passed
failed
not_run
```

The task card contains the cumulative snapshot. The commit subject/body
describes this run. Do not place full WorkState, tool output, evidence JSON, or
conversation text in the commit message.

## Commit Frequency

- One initial task identity commit.
- At most one normal final task commit for each mutating run.
- No commit for a purely read-only run.
- A state-only final commit is allowed when a run produces a durable useful
  request/task transition but no deliverable diff, such as recording a proven
  external blocker or a completed learning discussion in tracked notes.
- No empty commit merely to acknowledge a harmless reply.
- Exceptional safety checkpoints are deferred and must not be added casually.

## Schema Validation

Repository validation checks:

- path is a direct managed child of the task root
- path is a normal directory and Git top level
- `HEAD` exists on the durable branch
- `.ayati/task.md` exists and parses
- task ID matches catalog/directory identity
- schema is supported
- task status is valid
- referenced current request exists and is uniquely active
- request IDs and filenames are unique
- `.ayati/references.md` exists and parses bounded entries
- inbox ignore rule is present
- no tracked file exists underneath `.ayati/inbox/` except `.gitkeep`
- no engine-owned file contains secrets according to configured scanners

Read operations may return degraded context for some validation failures.
Mutation fails closed until identity and schema integrity are restored.

## Versioning

The schema marker is explicit:

```text
ayati.task/v1
ayati.request/v1
```

Future versions require deterministic readers and migration rules. Do not
silently reinterpret older files using new semantics.
