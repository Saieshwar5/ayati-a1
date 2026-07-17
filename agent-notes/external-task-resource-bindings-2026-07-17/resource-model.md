# Resource Model

## Identity Types

The following types define the implementation target. Names may be placed in
the existing contract modules, but their semantics are fixed by this plan.

```ts
type TaskWorkspaceMode =
  | "owned_checkout"
  | "adopted_checkout"
  | "managed_sidecar";

type ResourceKind =
  | "task_checkout"
  | "filesystem_file"
  | "filesystem_directory"
  | "git_repository"
  | "remote_resource";

type ResourceRelationship =
  | "owned"
  | "adopted"
  | "external";

type ResourceRole =
  | "workspace"
  | "input"
  | "mutation_target"
  | "publish_target"
  | "effect_target";

type ResourceCapability =
  | "read"
  | "create"
  | "modify"
  | "delete";

type ResourceWritePolicy =
  | "task_git"
  | "in_place"
  | "atomic_publish"
  | "external_api";
```

`resourceId` uses a stable service-assigned ID such as
`RES-20260717-000001`. It is not derived from a path, title, or content hash.

## Resource And Binding Separation

A resource is globally indexed operational identity. A binding is one task's
relationship to that resource.

```ts
interface ResourceRecord {
  resourceId: string;
  kind: ResourceKind;
  adapter: string;
  canonicalLocator: string;
  locatorFingerprint: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskResourceBinding {
  taskId: string;
  resourceId: string;
  relationship: ResourceRelationship;
  role: ResourceRole;
  capabilities: ResourceCapability[];
  writePolicy: ResourceWritePolicy;
  commitPolicy?: "explicit";
  sensitivity: "normal" | "sensitive";
  status: "active" | "detached" | "needs_rebind";
  createdRunId: string;
  lastRunId?: string;
  createdAt: string;
  updatedAt: string;
}
```

The same resource can be bound read-only to several tasks. Binding capability
is a maximum policy boundary, not proof of current mutation intent.

## Resource Identity Rules

### Task checkout

Identity is the task ID plus canonical repository identity. The model uses the
canonical absolute working directory; Git-relative paths remain private.

### Filesystem file or directory

Operational lookup uses the canonical absolute path. Existing paths resolve
all symlinks. New paths canonicalize the nearest existing parent and append the
remaining path. The observation may record device/inode identity as a signal,
but atomic replacement can change it, so it is not the stable primary key.

Aliases record verified renames or equivalent paths. A raw path string supplied
only by the model never creates an alias.

### Git repository

Identity contains the canonical repository root and a remote fingerprint when
one exists. A resource observation records HEAD, branch/detached state,
worktree identity, index fingerprint, status, and relevant target hashes.
Repository-relative target paths are adapter-private after the absolute root
is authorized.

### Remote resource

Identity uses an adapter namespace, configured account/profile identity,
resource type, and provider object ID. Credentials and access tokens are not
part of the locator or fingerprint.

## Portable Manifest

The engine writes one manifest per binding:

```json
{
  "schemaVersion": 1,
  "resourceId": "RES-20260717-000001",
  "kind": "filesystem_file",
  "adapter": "filesystem",
  "displayName": "Example application settings",
  "locatorFingerprint": "sha256:...",
  "relationship": "external",
  "role": "mutation_target",
  "capabilities": ["read", "modify"],
  "writePolicy": "in_place",
  "sensitivity": "sensitive"
}
```

Manifest rules:

- Store no credentials, tokens, complete file contents, active lease, baseline
  hash, or transient run state.
- Do not require a machine-local absolute path to be portable task metadata.
- Use deterministic key ordering and schema validation.
- The Git Context Engine is the only writer.
- Manifest changes are included in normal task-run finalization, never in an
  independent model-triggered commit.
- Detaching a binding preserves its manifest history; current status may be
  updated to `detached` rather than deleting historical identity.

## Observation

An observation is a time-bound adapter read:

```ts
interface ResourceObservation {
  observationId: string;
  resourceId: string;
  taskId: string;
  runId: string;
  adapter: string;
  version: string;
  identity: Record<string, unknown>;
  stateHash?: string;
  summary: Record<string, unknown>;
  observedAt: string;
}
```

`version` is adapter-specific: file hash, Git HEAD plus target-state digest,
remote etag/version, or another stable provider value. Summaries must be
bounded and redacted.

## Mutation Authority And Lease

```ts
interface ResourceMutationAuthority {
  authorityId: string;
  taskId: string;
  runId: string;
  resourceIds: string[];
  operation: "create" | "modify" | "delete" | "publish" | "effect";
  baselineObservationIds: string[];
  intentEvidence: {
    conversationId: string;
    messageId: string;
    source: "current_user" | "clarification";
  };
  tokenHash: string;
  status:
    | "active"
    | "applied"
    | "verified"
    | "released"
    | "recovery_required";
  acquiredAt: string;
  expiresAt: string;
}
```

Only a runtime-held raw token authorizes the tool execution. SQLite stores its
hash. Leases are unique per write resource while active. Many read bindings do
not require write leases.

## Mutation Receipt

```ts
interface ResourceMutationReceipt {
  receiptId: string;
  authorityId: string;
  taskId: string;
  runId: string;
  resourceId: string;
  adapter: string;
  operation: "created" | "modified" | "deleted" | "published" | "effect_applied";
  status: "verified" | "partial" | "failed" | "unknown";
  beforeObservationId?: string;
  afterObservationId?: string;
  idempotencyKey?: string;
  externalOperationId?: string;
  changeSummary: Record<string, unknown>;
  verification: Record<string, unknown>;
  rollback: "available" | "compensatable" | "unavailable";
  createdAt: string;
}
```

Receipts are normalized by the trusted adapter/executor. Large or sensitive
raw provider responses are stored only through the existing bounded evidence
rules, with hashes and references from the receipt.

## SQLite Schema Direction

Add normalized operational tables:

```text
resources
  resource_id primary key
  kind
  adapter
  canonical_locator
  locator_fingerprint
  display_name
  created_at
  updated_at

task_resource_bindings
  task_id + resource_id primary key
  relationship
  role
  capabilities_json
  write_policy
  commit_policy
  sensitivity
  status
  created_run_id
  last_run_id
  created_at
  updated_at

resource_aliases
  adapter + alias_locator unique
  resource_id
  verified_at
  source_observation_id

resource_observations
  observation_id primary key
  resource_id
  task_id
  run_id
  version
  identity_json
  state_hash
  summary_json
  observed_at

resource_mutation_authorities
  authority and intent fields
  authorized_resource_ids_json
  baseline_observation_ids_json
  token hash, status, expiry, timestamps, and last error

resource_mutation_receipts
  receipt fields, normalized change/verification JSON, and recovery status

resource_operation_journal
  idempotent request, phase, adapter, authority, receipt, and recovery fields
```

Add `workspace_mode` to the task catalog. Migrations backfill existing tasks
conservatively and create implicit checkout bindings lazily or through a
deterministic migration.

SQLite constraints must enforce:

- valid enum values;
- foreign keys to tasks/runs/resources;
- one active write lease per resource;
- one receipt identity per idempotent adapter operation;
- immutable receipt identity fields after verification; and
- indexed exact locator/fingerprint and task/resource lookup.

## Public Context Contracts

Task context adds:

```ts
interface TaskContextProjection {
  // existing fields
  workspaceMode: TaskWorkspaceMode;
  resources: TaskResourceContext[];
}
```

The projection is compact, capped, ordered by current-turn relevance, and
omits secrets. Exact current-turn resources outrank recently used resources.

WorkState adds bounded external progress without replacing existing artifacts:

```ts
interface RunResourceState {
  resourceId: string;
  operation: string;
  status: "observed" | "authorized" | "verified" | "partial" | "failed";
  receiptId?: string;
  summary: string;
}
```

## Completion Contracts

Retain internal completion assets and add:

```ts
interface TaskCompletionResourceInput {
  resourceId: string;
  operation: "created" | "modified" | "deleted" | "published" | "effect_applied";
  receiptId: string;
  description: string;
}

interface VerifiedTaskCompletionResource
  extends TaskCompletionResourceInput {
  verified: true;
}
```

Final task and session records persist both `assets` and `resources`. Historical
records without resources deserialize as an empty list.

## Model-Facing Resource Tools

Extend task routing with deterministic binding operations rather than exposing
database mutation:

- Task creation accepts workspace intent and optional initial resource
  proposals.
- A turn-aware `bind_resource` operation associates an exact discovered
  resource with the active/selected task.
- Binding input includes kind, locator, relationship, role, capabilities,
  write policy, reason, and evidence source.
- The service validates that the locator is supported by the current user
  message, verified read context, or clarification.
- Binding is lifecycle/routing work and does not consume ordinary selected-tool
  budget while ownership is unresolved.

Filesystem execution continues to use canonical absolute paths. Resource IDs
are context and authorization identities, not a requirement to replace every
existing tool path schema.
