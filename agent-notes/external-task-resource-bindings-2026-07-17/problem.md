# Problem

## Current Model

Ayati currently makes these concepts equivalent:

```text
task
= one canonical task Git repository
= one stable working directory
= one trusted filesystem mutation root
```

This is strong for work created and controlled by Ayati. A new website can be
created in a managed or explicitly requested directory, every mutation can be
verified through Git, and one task-run finalization commit records the complete
deliverable state.

The current implementation also supports importing an existing non-Git
directory as the baseline of a requested task checkout. It deliberately
rejects existing user Git worktrees and rejects task mutations outside the
active task working directory.

Those boundaries leave important real-world requests without a correct
ownership model:

- Create one file at a requested location outside a task checkout.
- Update a standalone file the user created.
- Modify a project in an existing user-owned Git repository.
- Generate an internal artifact and publish it elsewhere.
- Change a database, API object, deployment, account setting, or remote system.
- Complete one goal that contains both owned and external resources.

The problem is not relative versus absolute paths. Canonical absolute paths are
necessary, but arbitrary absolute-path permission would weaken routing,
authorization, verification, rollback, recovery, and auditability.

## Architectural Questions

The design must answer:

- What defines a task when Ayati does not own the target resource?
- Where does task history live when the external content is not in task Git?
- How does Ayati remember which task is associated with an external resource?
- How does a saved association avoid becoming permanent write authority?
- What proves an external mutation succeeded?
- What happens if the external mutation succeeds but Git finalization fails?
- How are dirty user repositories and concurrent edits handled?
- How can evidence remain useful without persisting secrets or complete
  external file contents?
- How does completion represent an API effect rather than a task-root file?

## Rejected Simplifications

### Force every resource into an Ayati task repository

This is intrusive for configuration directories, Desktop destinations,
existing repositories, databases, and remote systems. It also creates
artificial Git repositories in locations the user did not choose as projects.

### Copy external resources into a task and synchronize them back

This is appropriate for generated publication artifacts, but unsafe for
editable source resources because the copy and the original become competing
authorities.

### Allow unrestricted external paths after task selection

This turns task identity into a weak label and bypasses exact ownership,
bounded authority, task routing, and deterministic completion.

### Make external mutations taskless

This loses durable goal identity, continuation, recovery, receipts, and
cross-session recall. A read-only enquiry can remain session-scoped, but every
durable mutation still belongs to a task run.

### Create two independent task engines

Internal and external work share conversation, routing, WorkState,
verification, task state, finalization, and recall. Separate engines would
duplicate those lifecycles and fail on mixed tasks.

## Goals

- Preserve one durable task/run lifecycle.
- Give every task an Ayati-owned Git control repository.
- Keep external resources at their original canonical locations.
- Represent ownership and use through typed resource bindings.
- Route future requests by exact resource identity before semantic similarity.
- Require current user intent and a short-lived exact-resource lease for every
  external mutation.
- Record verified before/after observations and normalized receipts.
- Support deterministic recovery without repeating external effects.
- Extend completion and WorkState to represent external outcomes.
- Preserve privacy, user repository state, and user-owned instructions.

## Non-Goals

- Distributed transactions across unrelated files, repositories, and APIs.
- Guaranteed rollback for every external system.
- Automatic migration of historical tasks into the new resource catalog.
- Automatic commits to user-owned repositories.
- Secret storage or credential management inside Git Context Engine.
- A generic unrestricted shell escape for external work.
- Treating personal memory as task or resource truth.
- Replacing adapter-specific verification with model judgement.

## Product Outcome

The user should be able to ask Ayati to create, continue, edit, publish, or
operate on a resource in its real location. Ayati should remember the task and
resource relationship, re-observe current state before acting, modify only the
authorized target, verify the real outcome, and retain durable task and session
history without pretending that external content lives in task Git.
