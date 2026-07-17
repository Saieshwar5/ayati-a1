# Decisions

## Locked Decisions

### One task lifecycle

Ayati keeps one durable task, run, WorkState, verification, and finalization
lifecycle. Internal, external, and mixed are derived display classifications,
not persisted task engines.

### Every task has a Git control repository

Every durable task retains an independent Ayati canonical repository, stable
control checkout, task-state commits, and session gitlinks. An external-only
task uses a managed sidecar checkout.

### Three workspace modes

- `owned_checkout`: Ayati creates or exclusively controls the project checkout.
- `adopted_checkout`: the user clearly identifies an existing non-Git
  directory as the ongoing project root and Ayati imports its baseline.
- `managed_sidecar`: Ayati owns a managed control checkout while one or more
  canonical resources remain external.

An owned or adopted task may also bind external resources and become a mixed
task.

### Intent-based directory adoption

Ayati may adopt an existing non-Git directory without another confirmation
only when the current user request or verified context clearly treats that
directory as the ongoing project root. Naming one file or publication target
inside a directory does not authorize adopting the whole directory.

### Existing Git repositories remain user-owned

An existing Git repository is represented by a `git_repository` binding on a
sidecar or mixed task. Ayati does not replace its origin, convert it to an Ayati
canonical repository, require a globally clean worktree, reset it, or clean
untracked files.

### Explicit user-repository commits

Ayati commits into an existing user-owned Git repository only when the user
explicitly requests a commit. Unrelated dirty paths are preserved. The adapter
must refuse the commit when the run's exact changes cannot be separated safely
from pre-existing changes in an authorized target.

### Bindings remember identity, not authority

A durable resource binding supports recall, routing, policy, and context. It
does not grant future write access. Every run must derive clear mutation intent
from the current turn and receive a short-lived lease for exact resources.

### Typed resource model

Resource `kind`, task `relationship`, task `role`, capabilities, and write
policy are separate fields. For example, a PDF is a `filesystem_file` whose
role can be `publish_target`; publication is not a file kind.

### Human descriptor plus structured manifests

`.ayati/task.md` remains the small human-readable portable task descriptor.
Each bound resource has an engine-owned structured manifest under
`.ayati/resources/<resource-id>.json`.

Ayati never requires, creates, overwrites, or repurposes a root `AGENTS.md` as
task metadata.

### Machine-local locators remain operational data

Resource manifests contain stable IDs, portable identity, policy, display
metadata, and a locator fingerprint. Exact machine-local filesystem paths live
in SQLite and verified local run evidence. Losing the local mapping requires
deterministic reconstruction from available local evidence or explicit
rebinding; a portable manifest must not pretend that an absolute path works on
another machine.

### External resources remain canonical externally

Task Git is canonical for owned task content and compact task state. The real
external location is canonical for external content. Git stores resource
descriptors and state commits, not a synchronized editable copy.

### Normalized receipts are mutation truth

External mutation truth comes from adapter-owned before/after observations and
verification, persisted as normalized receipts. Model descriptions and raw
tool success strings are not sufficient evidence.

### Completion supports resources and assets

Internal files and directories remain completion assets. External mutations
and effects complete through verified current-run resource outcomes linked to
receipts.

### Conservative multi-resource behavior

Multiple resources may be changed in one run, but each mutation is journaled
and verified independently. Ayati reports partial success explicitly and does
not claim atomicity across external resources.

### Adapter-specific rollback

Rollback or compensation is recorded as a capability. V1 does not promise
automatic rollback when an adapter cannot provide it. Atomic filesystem writes,
idempotency keys, and explicit recovery status are preferred to unsafe generic
rollback.

### Privacy-first evidence

Receipts store identities, versions, hashes, changed-field/path summaries,
verification, and redacted diagnostics. They do not store credentials. Full
external contents and unredacted secret-bearing diffs are not persisted by
default.

## Compatibility Decisions

- Existing managed tasks map to `owned_checkout` with an implicit
  `task_checkout` resource.
- Existing requested task directories map to `owned_checkout` or
  `adopted_checkout` according to recorded initialization provenance when
  available; otherwise they remain compatible checkout tasks without guessing
  historical ownership.
- Existing task mutation authority remains the implementation path for
  checkout resources during initial rollout.
- External authority is added alongside it and exposed through a uniform
  application-layer resource authority contract.
- Existing task and session Git history is never rewritten.
- Older tasks do not need eager resource manifests; implicit checkout
  resources may be projected until the task is next updated.

## Deferred Decisions

- Cross-machine locator synchronization and user-facing rebinding UX.
- Encrypted rollback snapshots for sensitive or binary files.
- Automatic branch creation in user-owned Git repositories.
- Remote resource sharing across multiple Ayati installations.
- Long-lived background automation authority independent of a current user
  turn. This requires a separate scheduled-policy design and is not implied by
  resource binding.
