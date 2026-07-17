# Storage And Recovery

## Storage Ownership

| Information | Durable owner | Reason |
|---|---|---|
| Owned/adopted task files | Task Git | Canonical deliverable tree and diff history |
| Human task identity | `.ayati/task.md` in task Git | Portable, compact context |
| Resource descriptors | `.ayati/resources/*.json` in task Git | Portable binding identity and policy |
| External content/state | External location | Avoid competing canonical copies |
| Compact task progression | Task commit messages | Cross-session task state |
| Conversation | Daily session Git plus live SQLite/file journal | Exact user/assistant/system history |
| Completed run evidence | Daily session Git | Detailed explanation and audit trail |
| Resource mutation receipts | SQLite immediately, then session Git | Crash-safe external provenance |
| Exact local locators | SQLite | Machine-local routing and authorization |
| Active observations/leases/journals | SQLite | Fast concurrency and recovery |
| Credentials | Existing credential/configuration owner | Never Git Context metadata |
| Personal preferences | Personal memory | Not task or resource truth |

## Task Git

Task Git contains:

- owned/adopted deliverables when applicable;
- `.ayati/task.md`;
- resource manifests;
- exactly one final task-state commit per finalized task run; and
- compact trailers linking task, run, session, conversation, outcome, and
  validation.

The commit may be empty for an external-only run. It remains useful because it
advances durable task state and links to session evidence.

Task Git does not contain active leases, credentials, complete external file
snapshots, raw API responses, or a duplicate editable external source tree.

## Session Git

Keep the existing conversation and run files. Extend completed task-run
evidence with a normalized resource receipt stream:

```text
runs/<run-id>/
  run.json
  steps.jsonl
  resources.jsonl
```

`resources.jsonl` stores bounded completed observations and receipts for that
run. `steps.jsonl` remains the tool/action evidence. `run.json` summarizes
required and completed resource outcomes.

Receipt entries store:

- task, run, resource, authority, and receipt IDs;
- adapter and operation;
- before/after version or observation references;
- redacted change summary;
- verification status and assertions;
- provider operation/idempotency identifiers when applicable;
- rollback/compensation capability; and
- timestamps and recovery classification.

Do not duplicate complete file bodies. Content-bearing fields use existing
bounded evidence handling plus external-resource redaction rules.

## SQLite

SQLite is the first durable write for external operation journals and verified
receipts. The session Git file is produced through the existing recoverable
finalization/outbox pattern.

Required operational queries include:

- Find a resource by exact canonical locator/fingerprint.
- Find tasks bound to a resource.
- List current task bindings ordered by relevance/recency.
- Find active or uncertain leases.
- Find pending external operation journals.
- Find receipts not yet persisted to session Git.
- Compare the last observation with current external state.
- Reconstruct task completion inputs for a recovering run.

Important SQLite data is durable but machine-local. Completed history must be
represented in task/session Git sufficiently to explain the operation even if
the fast indexes are rebuilt. A missing exact machine locator may require
rebind rather than guessing.

## External Operation Journal

Every mutation uses recoverable phases:

```text
prepared
-> authority_acquired
-> request_dispatched
-> effect_observed
-> receipt_persisted
-> task_finalized
-> session_committed
-> completed
```

Filesystem operations may move directly from `authority_acquired` to
`effect_observed`. Remote adapters persist the idempotency key and, when
available, provider operation ID before advancing.

Each phase transition is idempotent and records the last error. Startup scans
every nonterminal journal before allowing a conflicting write lease.

## Crash Recovery

### Crash before dispatch

No external effect occurred. Reconcile the baseline, release the lease, and
retry only if the run is still active and current intent remains valid.

### Crash during local filesystem write

Inspect temporary and destination paths, compare baseline/final hashes, finish
or remove only adapter-owned temporary files, and classify the operation as
verified, failed-clean, partial, or recovery-required.

### Crash after effect but before receipt

Re-observe the exact resource. For remote systems, query by idempotency key or
provider operation ID. Never repeat the effect until absence is proven.

### Crash after receipt but before task commit

Treat the receipt as durable mutation truth. Resume task and session
finalization without re-executing the external operation.

### Crash after task commit but before session commit

Use the existing cross-repository finalization journal to persist run evidence,
resource receipts, conversation, gitlink, and session commit exactly once.

### Unresolvable state

Mark the journal, lease, run, and task as `recovery_required`. Block conflicting
mutations, expose a concise user-facing explanation, and retain all evidence.
Do not guess or silently release uncertain ownership.

## Concurrency And Leases

The database enforces one active/uncertain write authority per resource. Lease
expiry is used for liveness, not truth. An expired lease with a dispatched
operation remains unavailable until recovery determines whether the effect
occurred.

External applications may ignore Ayati's lease, so every adapter rechecks
baseline identity/version immediately before mutation and verifies afterward.

For several resources, acquire leases in stable resource-ID order inside one
SQLite transaction. Release all if the set cannot be acquired. Persist receipts
per resource after execution.

## Privacy And Redaction

Classify bindings as `normal` or `sensitive`. Configuration, credential,
identity, and system-policy locations default to sensitive.

For sensitive resources, persist by default:

- canonical identity or controlled locator reference;
- before/after hashes or provider versions;
- changed path/field names;
- redacted scalar summaries where safe;
- permissions and validation results; and
- omitted-content hashes and byte counts.

Do not persist:

- tokens, passwords, cookies, private keys, authorization headers;
- complete secret-bearing files;
- raw API bodies without adapter redaction; or
- environment values unrelated to verification.

Run evidence rendering must redact external resource tool inputs as well as
outputs. Patch `find`/`replace` values require the same scrutiny as generic
`content` fields.

## Rollback And Compensation

- Text/local file: atomic write prevents partial replacement; inverse patches
  or encrypted backups are deferred unless explicitly supported.
- Published output: retain the baseline observation; replacement rollback is
  available only if an adapter-created backup policy was explicitly enabled.
- User Git repository: Git may provide a patch/commit reference, but Ayati does
  not reset user state automatically.
- Remote API: store the provider-supported compensation operation when one
  exists; never assume reversibility.

Failure reporting distinguishes `available`, `compensatable`, and
`unavailable` instead of claiming a universal rollback guarantee.

## Rebuilding Operational State

After SQLite loss or explicit rebuild:

1. Read task catalog and task repository descriptors/manifests.
2. Recreate task/resource binding identities and portable policies.
3. Read session run evidence and resource receipt streams.
4. Rebuild observation/receipt indexes and last-run associations.
5. Reattach exact local locators only when they can be proven from local
   evidence and match the stored fingerprint.
6. Mark unverifiable mappings `needs_rebind`.
7. Do not recreate active leases; reconcile every nonterminal recorded
   operation before allowing writes.

Rebuild never rewrites existing task or session history.
