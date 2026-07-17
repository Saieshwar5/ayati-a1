# Architecture

## System Model

Ayati continues to treat the task as the durable unit of user intent. Resource
location and authorship do not create separate task types.

```text
Task
├── Ayati Git control repository
├── Workspace mode
├── Resource bindings
└── Runs
    ├── Observations
    ├── Short-lived authorities
    ├── Tool actions
    ├── Deterministic verification
    └── Mutation receipts
```

The three workspace modes describe the task's primary checkout relationship:

```text
owned_checkout
  task Git tree is the deliverable and Ayati created or exclusively controls it

adopted_checkout
  task Git tree is the deliverable and began as an explicitly adopted non-Git directory

managed_sidecar
  task Git tree is the control/history workspace; canonical targets are external
```

An owned or adopted task can later bind an API or publication destination. The
UI may then call it a mixed task, but its workspace mode and run lifecycle do
not change.

## Repository Topology

### Owned or adopted checkout

```text
/user-or-managed/project/
  .git/
  .ayati/
    task.md
    resources/
      RES-...json
  src/
  tests/
  deliverables...
```

The task's canonical bare repository remains under Git Context Engine data.
The stable working directory is the execution root, as it is today. An
implicit `task_checkout` binding represents this authority.

### Managed sidecar

```text
<workspace>/tasks/<task-id>-<slug>/
  .git/
  .ayati/
    task.md
    resources/
      RES-0001.json
      RES-0002.json
  staging/                 optional generated/publishable artifacts
```

External resources stay in place:

```text
/home/user/.config/example/settings.json
/home/user/projects/existing-repository/
provider://account/project/deployment
```

The sidecar may contain generated source artifacts when they are real task
assets. It must not contain an editable mirror presented as canonical external
source.

## Ownership Boundaries

The architecture has four distinct authorities:

1. Task Git owns task descriptors, resource manifests, task-owned deliverables,
   and compact task-state commits.
2. Session Git owns conversation segments and detailed completed run evidence.
3. SQLite owns unfinished operational state, local locators, indexes, journals,
   observations, receipts awaiting Git persistence, and active leases.
4. The external location owns current external resource content or state.

Personal memory may remember user preferences but never acts as resource
ownership or mutation authority.

## Routing

Routing begins with the user goal, then resolves resources:

```text
user turn
-> extract explicitly named resource identities
-> canonicalize or resolve through the responsible adapter
-> search exact resource catalog
-> find task bindings
-> choose the unique goal/resource owner, or clarify
-> activate/create task run
```

Priority is:

```text
exact resource id
-> exact canonical local path or remote identity
-> Git repository identity + repository-relative target
-> recorded alias
-> active task plus clearly continuous objective
-> semantic task similarity
-> clarification
```

A resource may be linked to more than one task. Multiple read relationships are
normal. If a mutation could reasonably continue multiple tasks, Ayati asks one
short ownership question rather than silently selecting the newest task.

## Task Creation And Workspace Selection

The model-facing task creation contract must make workspace intent explicit:

```ts
type TaskWorkspaceRequest =
  | { mode: "owned_checkout"; placement: "managed" }
  | {
      mode: "owned_checkout";
      placement: "requested";
      workingDirectory: string;
    }
  | {
      mode: "adopted_checkout";
      workingDirectory: string;
    }
  | { mode: "managed_sidecar" };
```

Rules:

- `owned_checkout/requested` accepts a missing or empty directory.
- `adopted_checkout` accepts an existing non-Git directory only when current
  user evidence identifies it as the ongoing project root.
- An existing Git worktree cannot be selected for either checkout mode.
- `managed_sidecar` is required when the primary canonical resource stays
  external.
- A sidecar task can receive initial resource bindings during routing.
- Old `managed` and `requested` placement requests remain accepted by the
  internal compatibility layer while model-facing schemas migrate.

## Resource Binding Boundary

A binding is created only from:

- a resource locator explicitly supplied in the current user message;
- an exact resource already bound to the selected task;
- a locator deterministically discovered by a verified read from user-provided
  context; or
- explicit user confirmation after clarification.

The model may propose a binding through routing, but Git Context Engine validates
the evidence source and canonical identity. A model-provided path or resource
ID alone is not authority.

The engine writes `.ayati/resources/` manifests. General filesystem tools and
the model cannot mutate `.ayati` metadata directly.

## Authority And Execution

The application layer exposes one resource-authority abstraction while
preserving the existing proven task-checkout implementation:

```text
checkout target
-> current task mutation authority
-> Git-derived verification and staging

external target
-> resource lease and adapter authority
-> adapter-derived before/after verification and receipt
```

Before mutation, the executor:

1. Resolves the structured target to a binding.
2. Confirms current-run user mutation intent.
3. Checks binding capabilities and policy.
4. Captures a fresh baseline observation.
5. Checks for conflicting active leases.
6. Writes a pending operation journal.
7. Acquires a short-lived exact-resource lease.
8. Passes the adapter a runtime-only authority token.

Filesystem tools continue to receive canonical absolute paths. The executor
matches them to exact bindings or authorized descendants. API tools continue to
use provider-native resource IDs, but their adapter maps them to bound resource
identity and receipts.

For a multi-target tool call, all required leases are acquired in stable
resource-ID order before execution. If any cannot be acquired, none are
granted. Verification and receipts remain per resource because the external
effects are not collectively atomic.

## Deterministic Verification

Each adapter owns its mutation truth:

- Task checkout: Git diff and verified staged paths.
- Standalone file: baseline identity/hash, resulting identity/hash, type, and
  tool-contract assertions.
- Directory: bounded changed-path set, per-path observations, and requested
  structural assertions.
- User Git repository: HEAD, branch, index/worktree baseline, per-target diff,
  and unchanged unrelated state.
- Published output: temporary artifact hash, atomic destination operation, and
  final destination observation.
- Remote resource: provider object identity, idempotency key, operation ID,
  version/etag when available, and a follow-up read or authoritative response.

The executor persists a normalized receipt before reporting a verified success
to the harness.

## WorkState And Completion

WorkState retains existing facts, evidence, and owned artifacts and adds a
compact current-run resource outcome projection. It does not become canonical
task state.

Completion has two channels:

```text
assets
  verified files/directories canonical in the task checkout

resources
  verified external outcomes backed by current-run receipts
```

`task_completion` accepts an external outcome only when:

- the binding belongs to the active task;
- the receipt belongs to the active run;
- the requested operation matches the verified receipt;
- no later observation invalidated the result; and
- no unresolved partial or recovery-required condition remains.

An external-only task can finalize with no internal asset. The existing task
finalization mechanism may create an empty task-state commit while the resource
manifest, task commit trailers, and session evidence retain durable history.

## Context Projection And Recall

The context pack presents a bounded resource summary:

```ts
interface TaskResourceContext {
  resourceId: string;
  kind: ResourceKind;
  relationship: ResourceRelationship;
  role: ResourceRole;
  displayName: string;
  locator?: string;
  capabilities: ResourceCapability[];
  lastOutcome?: string;
  lastObservedVersion?: string;
  lastRunId?: string;
}
```

The exact locator is shown only when needed for the active local task and safe
for the provider context. Credentials and secret values are never projected.
External content is re-read on every run that depends on it; previous content
is evidence, not current truth.

## Derived Display Classification

UI labels are calculated rather than persisted as routing authority:

- Internal: checkout workspace and no external mutation/effect bindings.
- External: managed sidecar whose deliverable outcomes are external.
- Mixed: owned/adopted checkout plus external mutation/effect bindings, or a
  sidecar containing meaningful owned build artifacts and external outcomes.

Changing this label never changes task identity or history.
