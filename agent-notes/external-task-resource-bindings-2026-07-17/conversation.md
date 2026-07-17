# Conversation And Design Direction

Created: 2026-07-17

## Problem Raised By The User

Ayati handles a task created from scratch well because the task repository,
working directory, deliverable files, Git mutation authority, and task history
all describe the same owned state.

The user identified two important cases that do not fit that assumption:

1. Ayati is asked to create a file somewhere outside its task directory.
2. Ayati is asked to modify a file or directory it did not create, including an
   existing project or an external system accessed through an API tool.

The user correctly rejected moving those resources into a task directory. That
would alter the requested location and make ownership/tracking confusing.

## User's Initial Direction

The user suggested internal and external task classifications:

- Internal: Ayati has full control, such as a website created from scratch.
- External: Ayati creates or modifies something outside the task directory or
  operates on an external system.

The user also wanted every task to have a task directory and a durable metadata
file so the agent can understand and continue it.

## Architecture Refinement

The agreed refinement keeps the valuable parts of that idea while avoiding two
task engines:

- Every durable task has an Ayati-owned Git control repository.
- Task is the durable user goal, independent of resource location/authorship.
- Workspace mode is owned, adopted, or sidecar.
- Resources have typed task relationships and roles.
- Internal/external/mixed are derived display labels.
- External resources stay canonical in their real locations.
- Ayati stores bindings, observations, mutation receipts, verification, and
  task/session history.

This handles mixed goals such as building an internal website, publishing a
report externally, and deploying through an API as one coherent task.

## Naming Decision

Ayati will not use a root `AGENTS.md` as task metadata. Existing projects may
already own that file, and coding agents interpret it as instructions.

The agreed layout is:

```text
.ayati/
  task.md
  resources/
    <resource-id>.json
```

`task.md` is human-readable task context. Resource manifests provide structured
portable identities and policies. Machine-local locators remain operational
metadata.

## Locked User Choices

### Existing non-Git directory

Intent-based adoption: adopt/import it when the user's request clearly treats
the directory as the ongoing project root. Otherwise create a sidecar and bind
only the requested resource.

### Existing user Git repository commits

Explicit commit: Ayati may edit bounded authorized files, but commits into the
user repository only when the user explicitly asks. Unrelated repository state
must be preserved.

### Metadata shape

Use `.ayati/task.md` plus structured per-resource manifests.

### Later-run authority

A saved binding remembers identity and routing but does not provide permanent
write permission. Each run needs clear current mutation intent and a
short-lived exact-resource lease.

## Core Agreed Invariant

```text
Every durable mutation belongs to a task run.

Every task has an Ayati-owned Git control repository.

Task-owned resources are canonical in task Git.

External resources remain canonical externally, while Ayati stores durable
bindings, receipts, provenance, verification, and task history.
```

## Implementation Direction

Implement the shared model first, followed by exact external files, published
outputs, resource-aware completion/recovery, existing Git repositories, and
finally structured remote/API effects. Do not begin with arbitrary external
path escape flags or generic shell authority.
