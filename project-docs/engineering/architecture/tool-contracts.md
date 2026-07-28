# Tool Contracts

Built-in capabilities use machine-checkable contracts:

```text
structured result -> deterministic assertions -> verified facts
                  -> run-local progress reducer + verification index
```

The reducer does not copy routine tool proof into WorkState. Successful
terminal validation promotes only a bounded receipt for each selected
responsibility outcome.

## Purpose and Effect

Every executable tool has one purpose:

- `list`
- `read`
- `search`
- `control`
- `mutation`

Purpose explains why the model chooses a call. Runtime-owned effect determines
safety:

- `read_only`
- `workspace_mutation`
- `context_mutation`
- `external_mutation`
- `destructive`

Unknown classifications fail closed. Destination-specific mode controls such
as `decision_enter_observe_investigate` and `decision_resolve_create`, together
with `decision_stop`, are native harness controls, not ordinary executable
catalog tools and not persisted task steps. Successful completion does not use
a control call: after stored validation passes, the model returns normal
assistant text.

## Tool Metadata

A tool can declare native input/output schemas, annotations, a result contract,
and an error contract. The model sees the selected names and input schemas.
The executor owns effects, output validation, and verified-fact extraction.

## Host Paths and Resources

Model-facing host paths are canonical absolute paths. Relative paths, `.`,
`..`, and `~` are rejected rather than repaired. Syntax validation does not
grant access.

Absolute paths are not the correct representation for every path-like value.
Ayati uses two deliberately separate contracts:

- `AbsoluteFilesystemPath` identifies a host location at a tool, resource,
  configuration, or persistence boundary. It never resolves through the
  daemon's current working directory.
- `ResourceRelativePath` identifies a portable child inside an already named
  resource. It is always paired with a resource id, uses a field named
  `relativePath`, and rejects absolute paths plus empty, `.` and `..`
  segments.

Repository-relative names, archive members, completion assets, and mutation
targets inside a bound resource therefore remain relative by design. Turning
those values into host absolute paths would discard resource identity, reduce
portability, and make containment harder to audit. A generic field named
`path` must not silently switch between these two contracts.

The temporary operator-owned filesystem policy separates observation from
mutation:

```text
readScope=machine
mutationScope=workspace
```

The core filesystem observation tools—`read_files`, `inspect_paths`,
`list_directory`, `find_files`, and `search_in_files`—accept canonical absolute
paths anywhere the daemon's operating-system account can read. This works on
bound and unbound runs. The scope policy permits symbolic-link targets outside
the workspace; content reads follow the target while metadata tools retain
their own link semantics. It does not bypass host permissions, elevate
privileges, or treat devices and other non-regular paths as ordinary files.
Existing file-size, traversal, depth, entry-count, and
model-facing output bounds still apply. Searches with omitted roots default to
`<AYATI_ROOT_DIR>/workspace/`; broader discovery requires explicit roots.

Machine-read authority grants no workstream ownership or mutation authority.
With `mutationScope=workspace`, every declared filesystem effect is
canonicalized against `<AYATI_ROOT_DIR>/workspace/` before resource lookup,
mutation preparation, temporary-file creation, or tool execution. External
paths fail with `PATH_OUTSIDE_MUTATION_WORKSPACE`. Both move endpoints must be
inside, and symbolic-link escapes are rejected. `allowExternalPath` is removed
before execution and cannot override the operator policy.

Inside-workspace location is necessary, not sufficient. Mutation still
requires immutable workstream binding, a resource bound with
`access: "mutate"`, exact targets, mutation-journal preparation, and
post-operation verification. The optional operator value
`mutationScope=bound_resource` restores the older bound-resource boundary
without changing the executor.

Mode transitions keep search subjects, read-only references, and mutation
scopes in separate typed fields. A reference path cannot become mutation
authority merely because it is absolute. Mutation directory containment is
checked on canonical paths, including missing future children through their
nearest existing ancestor, and rejects symbolic-link escapes.

Process and Python mutation-capable calls declare an inside-workspace working
directory and exact inside-workspace effect targets. Mutable database calls
declare an inside-workspace database destination, and dataset promotion
declares an inside-workspace target database. Calls without enough declared
target information fail closed. Long-running processes cannot receive
open-ended filesystem access. Unexpected changes fail verification.

These declarations are Ayati's authorization contract, not an operating-system
sandbox around arbitrary native or Python code. A deployment requiring
host-enforced containment must separately sandbox or disable those
general-purpose execution tools.

## Workstream Controls

The primary model may use these read-only observations after entering a
matching observation mode:

- `git_context_find_workstreams`
- `git_context_read_workstream`
- `git_context_find_resources`

Their capability ids are `workstream:search`, `workstream:read`, and
`resource:ownership`. They identify routing and cannot satisfy task
completion by themselves.

Workstream search reports matching request identities and states from the
request FTS index, including terminal requests. `git_context_read_workstream`
accepts an optional exact `R-*` id so the model can answer from a completed or
dropped request without reopening or binding it.

Hidden deterministic lifecycle controls:

- `git_context_inspect_resource`
- `git_context_create_workstream`
- `git_context_activate_workstream`

Explicit preference control:

- `git_context_set_workstream_star`

Bound resource control:

- `git_context_bind_resources`

Reading never binds. When the main run enters `resolve` with a binding-required
capability, evidence-backed mutation scope, and typed request-routing or
workstream-creation proposal, the runtime validates current-run routing
evidence and invokes one atomic Context Engine binding operation without a
model call. It then enters `execute` mechanically before asking for a fresh
decision. Routing an existing workstream must explicitly continue, amend,
activate, resume, create, or atomically defer and switch its request.
Replay identity derives from the existing run id and deterministic gate id.
An ambiguity that performs no binding does not consume the mutation-safe
binding attempt. An explicit create-new instruction or an exact follow-up
choice to the prior durable question bypasses semantic reuse suggestions;
authoritative resource checks still apply.

## System Observations

Two runtime-created, read-only tools provide fresh local observations without
a workstream or resource target:

- `system_time` returns the current UTC timestamp, configured or requested IANA
  timezone, local date and time, weekday, and UTC offset.
- `system_health` returns a bounded snapshot of CPU load, memory availability,
  the volume containing Ayati's data root, system uptime, and Ayati process
  memory.

They are exposed through the targetless `system:time` and `system:health`
capabilities in `observe.investigate`. `system_health` accepts no caller path
and does not reveal hostname, network addresses, environment variables,
process lists, or the configured data-root path. A degraded or critical
measurement is still a successful observation; collection failure is a tool
failure.

Successful contracts emit `system.time_observed` or
`system.health_observed`. Final validation queries those current-run outcomes
instead of sampling the clock or machine a second time. The timestamp in each
result defines when the observation was made; a stored observation is not an
ever-current fact.

## Verification Path

1. Validate the action plan and tool input.
2. Resolve resource ownership and prepare exact mutation observations when
   required.
3. Execute the call.
4. Normalize its structured result.
5. Run tool-owned contracts and action assertions.
6. Verify resource effects.
7. Extract artifacts and grounded facts.
8. Persist one run step; do not duplicate its proof into WorkState.

Tool success and validation success are distinct. Only contract-backed facts,
deterministic evidence, and verified artifacts advance progress.

Every executed call owns one compact verification record. Its status is
`passed`, `failed`, or `not_available`; an error-free tool result without a
deterministic contract is never promoted to `passed`. The record normalizes
the verification method, required check statuses, grounded facts, and a
focused failure code while leaving the complete input and output on the
surrounding call. A step aggregates these independent records instead of
copying one step-wide verification result onto every call.

The model-facing call is smaller than the durable record. It keeps the useful
input, output, purpose, execution and operation status, artifacts,
continuation metadata, and a scalar `verificationStatus`. A failed
verification also keeps its compact actionable code and message. Methods,
contracts, checks, fact payloads, compatibility booleans, and filesystem
completion-evidence objects are not repeated there. They remain durable and
feed the derived verification index.

Tool-contract verification is local to one action: it checks input, execution,
declared assertions, and effects before the step is persisted. It does not
update WorkState. Filesystem evidence records path state, read coverage,
content availability, filename-search completeness, mutation state, and
step/call identity. A zero-match filename search becomes completion proof only
when it was uncapped, error-free, and did not stop at its depth limit. An explicit
completion registry maps eligible facts from calculator, database, Pulse,
process, Python, memory, system-observation, and artifact tools into stable
typed outcomes.
Unregistered facts remain supporting evidence rather than silently becoming
completion proof.

Final validation does not re-verify the action history and makes no action
calls. It checks only the few required current-run completion proofs that
establish whether the current responsibility is ready to close. A complete
read proof requires explicit `coverage=complete`; `truncated=false` alone is
not sufficient. Bounded slice, search, and profile responsibilities use the
separate `file.read_scope_satisfied` outcome. Its exact path and scope must
match an untruncated verified read; automatic samples and generic partial
reads are not promoted. Completion proofs are eligible only when their exact owning
call has a passed per-call verification record. Older records that only
contain `verificationPassed` remain readable during migration, but new calls
derive that Boolean from the per-call record.

The validation request uses
`{ kind, subject, expectedKind?, searchScope?, readScope?, denialCode? }`. The runtime
matches it against the latest current-run eligible outcome and writes the
satisfying run/step/call reference into the check result. A later filesystem
mutation invalidates stale path/read proof and affected no-match searches. A
deterministic runtime-check call
may expose `tool.call_succeeded` by exact `callId` only when no stronger typed
outcome exists. A deterministically rejected permission call may expose
`tool.call_denied` by exact `callId` and stable `denialCode` only when the call
did not perform the requested operation. That proves the denial, never a read
or mutation success. Routing and historical calls cannot satisfy task validation.
The decision model obtains these selectable fields from the compact
`context.run.verifiedOutcomes` projection rather than reconstructing proof
from success-sounding tool output.

When a passed checklist is followed by an accepted final response, the runtime
converts at most four of those exact passed checks into compact WorkState
`importantContext` receipts. Each receipt keeps an outcome description and the
satisfying run/step/call reference. It does not copy the call input/output,
verification method, contracts, checks, hashes, facts, or filesystem evidence
object.

## Failure Contracts

Stable codes should name recoverable conditions such as invalid input, missing
path, stale version, denied resource access, timeout, verification failure, or
missing workstream binding. Repairs are fed back into the next model decision;
failed mutations are never deferred or replayed.

When truthfully reporting an exact denial fulfills the user's responsibility,
passed `tool.call_denied` validation resolves only the action failure owning
that exact call and records `denial_reported`. Other failures remain active,
and the failed step remains failed in the journal. If the requested operation
itself had to occur, the run remains blocked or failed.

When adding a tool, add its taxonomy and contracts in the same change. Broad
multi-operation tools and unclassified behavior are rejected by policy audit.
