# Lifecycle

## Common Task Run Flow

All workspace modes use one run lifecycle:

```text
user message
-> session run
-> resolve task and resource ownership
-> activate or create task
-> bind newly authorized resources
-> observe current resource state
-> acquire exact mutation authority
-> execute through the responsible adapter
-> derive and verify actual changes
-> persist receipt and update WorkState
-> evaluate task completion
-> finalize task Git and session Git
-> release remaining leases
```

Read-only inspection may remain session-scoped. The first durable mutation
promotes the run to exactly one task, as it does today.

## Owned Checkout

Example: “Create a coffee-shop website.”

1. Create an `owned_checkout` task with managed placement unless the user
   supplied a new/empty requested directory.
2. Create the canonical task repository, stable checkout, `.ayati/task.md`, and
   implicit `task_checkout` binding.
3. Use existing checkout mutation authority and Git-derived provenance.
4. Verify completion assets inside the checkout.
5. Finalize exactly one task-state commit and one session task-run commit.

This path remains behaviorally equivalent to the current system.

## Adopted Non-Git Checkout

Example: “Continue the project in `/home/user/projects/demo`.”

1. Confirm current user evidence treats the directory as the project root.
2. Canonicalize and inspect the directory.
3. Reject nested/existing Git worktrees, overlapping Ayati task roots, reserved
   `.ayati` conflicts, and unsupported filesystem types.
4. Create an `adopted_checkout` task.
5. Initialize the task identity and import existing ordinary files as one clean
   baseline commit, preserving ignored/private files according to the defined
   import policy.
6. Verify the stable checkout and canonical repository agree.
7. Continue through existing task Git authority.

Naming one file inside an existing directory does not select this lifecycle.

## Standalone External File

Example: “Change the theme in
`/home/user/.config/example/settings.json`.”

1. Create or activate a managed-sidecar task.
2. Resolve the exact file from current user evidence.
3. Create/reuse a `filesystem_file` binding with role `mutation_target`.
4. Read the complete current file through the filesystem adapter and capture
   canonical identity, type, permissions, size, and SHA-256.
5. Mark sensitive configuration resources conservatively.
6. Acquire an exact-file lease using current-turn modify intent.
7. Re-check the baseline immediately before writing.
8. Apply a bounded patch or base-hash-protected replacement atomically.
9. Re-read and validate the real file.
10. Persist before/after observations and a redacted receipt.
11. Complete through the receipt; no external file is copied into task Git.

If the baseline changed, no write occurs. The agent receives current state and
must re-evaluate rather than blindly retrying the stale patch.

## Published Output

Example: “Create `/home/user/Desktop/sales-report.pdf`.”

1. Create or activate a sidecar task.
2. Bind the exact destination as a `filesystem_file` with role
   `publish_target` and `atomic_publish` policy.
3. Generate the artifact inside the sidecar or another owned task location.
4. Validate the owned artifact before publication.
5. Observe the destination. If it exists, capture its baseline and require the
   current request to authorize replacement.
6. Acquire the exact destination lease.
7. Copy/write to a same-directory temporary path controlled by the adapter.
8. Verify the temporary file's size, hash, type, and requested format.
9. Atomically rename it over or into the destination.
10. Re-observe the real destination and persist a publication receipt.

Do not initialize a task repository in Desktop or another broad destination.
The internal artifact and published destination may both appear in completion,
one as an asset and one as a resource outcome.

## Existing User Git Repository

Example: “Fix the login bug in `/home/user/projects/my-app`.”

1. Detect the existing Git root and use a sidecar or mixed task.
2. Bind a `git_repository` resource and separately record authorized target
   paths for the run.
3. Observe repository root, worktree identity, HEAD, branch/detached state,
   origin fingerprint, index state, staged/unstaged/untracked paths, and exact
   target hashes.
4. Allow unrelated dirty paths, but never claim or alter them.
5. Acquire the repository write lease and exact target authority.
6. Re-check HEAD and target baselines before each mutation.
7. Apply changes only through bounded filesystem paths or the Git adapter.
8. Verify the run-derived patch and prove unrelated state is unchanged.
9. Persist a receipt even when no user-repository commit is requested.

### Explicit commit

When the user explicitly asks for a commit:

1. Confirm HEAD/branch and the captured target/index baselines are unchanged.
2. Refuse if an authorized target had pre-existing changes that cannot be
   separated from the run patch.
3. Stage only run-produced target changes using an adapter operation that
   preserves the user's unrelated index state.
4. Create the requested commit without replacing remotes or switching branches
   implicitly.
5. Restore/preserve unrelated staged state exactly.
6. Verify the resulting commit contains only authorized run changes.
7. Record commit SHA and post-commit repository observation in the receipt.

If safe separation is impossible, leave verified working-tree edits intact,
do not commit, and ask the user how to handle the conflict.

## External API Or Remote System

Example: “Deploy this website to the configured hosting project.”

1. Resolve provider, configured account/profile, remote resource type, and
   object identity without exposing credentials.
2. Create/reuse a `remote_resource` binding with role `effect_target`.
3. Read current remote version/state when supported.
4. Write a pending operation journal and deterministic idempotency key before
   the external request.
5. Acquire the exact remote-resource lease.
6. Execute through the specific tool adapter.
7. Persist provider request/operation ID immediately.
8. Verify through a follow-up read, authoritative response, or provider status
   endpoint.
9. Store a normalized, redacted receipt.

If the request times out after submission, status becomes `unknown` rather than
failed. Recovery queries the provider using the idempotency key or operation ID
before any retry.

## Mixed Task

Example: “Build the website, publish the PDF report, and deploy it.”

One task may contain:

- an owned checkout;
- a published filesystem destination; and
- a remote deployment resource.

The run uses checkout authority for owned files and resource leases for the
external outcomes. WorkState records each independently. Completion is accepted
only when all required criteria have current verified evidence or explicitly
reports an incomplete/blocked outcome.

## Binding An Additional Resource

During an active task, the user may introduce a new resource:

> Also update `/etc/example/app.conf` as part of this deployment.

The turn-aware binding operation:

1. Confirms the current message supports that exact locator and operation.
2. Resolves canonical identity through the adapter.
3. Searches for an existing resource record and task bindings.
4. Reuses identity or creates a new resource.
5. Creates the binding and engine-owned manifest.
6. Refreshes task context before mutation.

If the resource clearly belongs to a different goal/task, routing resolves that
ownership instead of attaching it automatically to the active task.

## Later Recall

On a future turn:

1. Canonicalize mentioned identities and search exact resource indexes.
2. Rank task bindings by exact ownership, current active task continuity, and
   goal relevance.
3. Activate the unique owner or clarify between multiple plausible tasks.
4. Project the compact binding and last receipt into context.
5. Re-observe the canonical external resource before relying on prior state.

The previous receipt explains what Ayati did; it does not assert that external
state is unchanged.

## Concurrency

- Many tasks and runs may read the same resource.
- Only one active write lease may exist for a resource.
- Multi-resource leases are acquired atomically in sorted resource-ID order.
- A lease expires, but expiry alone never proves a partially executed operation
  did not happen.
- Recovery reconciles operation journals before releasing uncertain leases.
- Baseline version checks remain mandatory even when a lease is held because
  external applications do not honor Ayati's lock.

## Partial Failure

If a run modifies three resources and the third fails:

- keep verified receipts for the first two;
- store the third as failed, partial, or unknown;
- set WorkState and task outcome to incomplete or recovery-required;
- do not fabricate transaction-wide rollback;
- compensate only when the adapter provides a verified compensation action;
- tell the user exactly which external outcomes succeeded.

## Finalization

After all resource operations reach durable verified/terminal receipt states:

1. Update engine-owned resource manifests if bindings changed.
2. Evaluate internal assets and external resource outcomes.
3. Create the normal task-state commit, allowing an empty content diff for an
   external-only run.
4. Persist task HEAD to the canonical repository.
5. Write conversation, run evidence, steps, and resource receipts into the
   session repository.
6. Advance the session gitlink and commit the complete conversation window.
7. Mark receipts/finalization complete and release leases.

External effects are never rolled back merely because the later Git commit
failed. Recovery finishes durable recording from the operation journal.
