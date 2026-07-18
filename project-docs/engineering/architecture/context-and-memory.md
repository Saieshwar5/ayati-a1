# Context and Memory

Ayati uses several context layers because conversation, durable task state,
runtime evidence, and user memory have different lifecycles. Git is the durable
continuity layer for sessions and tasks; SQLite is the operational catalog and
run journal; prompt context is a bounded projection of both.

## Ownership

The independent `ayati-git-context` server is the only owner of context SQLite
and Git mutations. `ayati-main` talks to it through `GitContextRuntime` over a
local Unix socket managed by `ManagedGitContextProcess`.

The daemon owns the agent harness, personal/episodic memory, attachments, tool
execution, verification, and prompt assembly. The model can express task
selection intent through public tools but cannot directly edit Git metadata or
runtime-owned `.ayati/` lifecycle files.

## Session Continuity

A daily session is a normal Git repository. Its durable shape is intentionally small:

```text
session/meta.json
conversations/
```

Conversation synchronizers write user, assistant, and system records under
`conversations/`. Session checkpoints commit those records so a later process
can reconstruct the conversation independently of task repositories.

A session is a communication timeline. It does not own task files. Closing or
rotating a session must not make a task unavailable.

## Task Continuity

Each durable task is an independent Git repository with a stable working
directory. New tasks use `T-*` identities and the V1 `.ayati/` contract:

```text
.ayati/
  task.md
  requests/
  references/
  inbox/        # ignored staging
```

The repository contains the real deliverable beside `.ayati/`. `task.md`
answers what the task is, its current status, what matters now, and the next
step. Request files record meaningful units of user intent and their outcomes.
References hold curated durable context; inbox holds untracked user-provided
material until it is deliberately adopted or discarded.

See [Task Repositories](task-repositories.md) for the complete contract,
selection semantics, commit ownership, and known gaps.

## Run-First Routing

Every provider-handled turn begins as a session run. Read-only exploration can
continue without selecting a task. Durable mutation requires an explicit task
selection:

- `git_context_create_task` creates and selects a new V1 task and initial
  request.
- `git_context_activate_task` selects an existing task. V1 calls explicitly
  choose whether to continue its active request or create a new request.

The response returns the selected task/run identity, stable working directory,
and refreshed harness context containing the request. The model-facing tools
use internally generated operation identities today, so stable retry identity
across a fresh repeated model call remains a reliability gap.

Pending-turn projections may be `unbound`, `bound`, or `clarifying`. These are
runtime context states, not durable task branches. If ownership is ambiguous,
the assistant asks the user a direct question; the answer arrives as a fresh
turn and can then select a task explicitly.

No session-global active task grants mutation authority. A visible candidate,
recent task, or prior selection is useful context only.

## Requests and Runs

A task is long-lived; a request is a bounded user intention within that task;
a run is one execution attempt. A learning task may contain many requests over
months. A website task may be completed once and later receive redesign,
maintenance, or feature requests without becoming a new task.

For V1 task work:

1. Git Context allocates or continues the request and binds the run.
2. Task-scoped tools operate in the stable repository working directory.
3. Verification determines which facts and outputs are trustworthy.
4. Runtime finalization updates the request outcome and task card.
5. One task commit records the verified repository result.

SQLite retains detailed run lifecycle and raw evidence. The task repository
keeps compact durable outcomes. Large transcripts and raw tool output do not
belong in Git by default.

## Prompt Context Projection

The context pack is a bounded, machine-readable view prepared for the current
decision. Depending on the turn it can include:

- recent conversation tail;
- pending-turn and session-run state;
- task candidates or the explicitly selected task;
- active request and compact task card;
- recent Git activity and useful evidence pointers;
- current-run attachments;
- loaded tool groups and available follow-up groups;
- sparse work state and verification facts;
- stable personal facts and relevant episodic recall.

It should not include every task repository, every old conversation, full Git
logs, or unrestricted raw outputs. Search and read operations retrieve deeper
context only when needed.

The compatibility projection currently groups context into areas such as
`timeline`, `git`, `tools`, `harness`, `run`, and `personal`. These are prompt
organization boundaries, not separate sources of durable truth.

## Active Run Context

The harness keeps a sparse in-memory state for the active run. It contains only
information needed for the next decision: goal, plan, selected task/request,
attachments, executed actions, verified facts, blockers, and next step.

Tool working sets are also run-scoped. The hidden catalog can be searched and
bounded groups can be loaded, but the prompt should not expose every tool
schema at once.

Ayati no longer depends on harness-local `data/runs/<runId>/` state trees.
Operational run records live in Git Context SQLite and feedback traces; durable
task outcomes live in the task repository.

## Attachments and Task References

Attachments first enter the managed file/directory library. This gives tools a
stable, controlled copy without committing user data. When an item is relevant
to a task, it can be staged in `.ayati/inbox/` and then deliberately handled:

- promote a small, safe, durable source into `.ayati/references/`;
- extract a compact note or pointer into a tracked reference;
- move real deliverable content into the project tree; or
- leave sensitive, large, generated, or temporary input untracked.

The agent must never assume that every attachment belongs in Git.

## Personal and Episodic Memory

`PersonalMemoryStore` contains stable user facts and preferences used across
tasks. `PersonalMemorySnapshotCache` prepares a bounded prompt snapshot.
Personal memory must not become a substitute for task state.

Episodic memory indexes closed-session material when embeddings are available.
It helps recall past events semantically, but Git remains the inspectable source
for exact session and task history.

## Context Pressure and Compaction

When context grows, preserve durable facts and pointers before prose. Prefer:

1. current user intent and safety constraints;
2. selected task/request and task card;
3. verified facts, blockers, and next step;
4. relevant attachments and references;
5. recent conversation needed for coherence;
6. older narrative that can be retrieved later.

Compaction must not silently change task ownership, request choice, verification
status, or the distinction between task Git and external side effects.

## Recovery Model

After restart, the system should be able to:

1. open the daily session repository and recover conversation continuity;
2. query the catalog for task candidates;
3. inspect a selected task repository directly;
4. read `.ayati/task.md`, the active request, references, and Git history;
5. continue or create a request explicitly; and
6. resume work in the same stable working directory.

Catalog rebuild from repositories is not fully implemented yet. Until it is,
both the Git repositories and context SQLite data must be backed up as runtime
state.
