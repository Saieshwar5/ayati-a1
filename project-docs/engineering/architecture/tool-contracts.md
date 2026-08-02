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

Read-only host references and existing mutation authority are canonical
absolute paths. New-workstream outputs use typed workspace-relative targets,
and direct filesystem mutation tools may use workspace-relative paths after
binding. Syntax validation does not grant access.

Absolute paths are not the correct representation for every path-like value.
Ayati uses two deliberately separate contracts:

- `AbsoluteFilesystemPath` identifies a host location at a tool, resource,
  configuration, or persistence boundary. It never resolves through the
  daemon's current working directory.
- `ResourceRelativePath` identifies a portable child inside an already named
  resource. It is always paired with a resource id, uses a field named
  `relativePath`, and rejects absolute paths plus empty, `.` and `..`
  segments.
- `WorkstreamWorkspaceTarget` identifies a prospective file or directory
  beneath the configured workspace. It carries `kind: file | directory` and a
  `relativePath`; it never carries the workspace root, a resource id, or an
  evidence reference.

Repository-relative names, archive members, completion assets, and mutation
targets inside a bound resource can remain relative by design. For a
new-workstream target, the resolve gate joins `relativePath` to the configured
workspace, canonicalizes the result, and rejects absolute input, `.`, `..`,
empty segments, and symbolic-link escape. For a direct filesystem mutation
tool, the resource-scoped executor resolves a relative `path` against the
workspace once before policy and resource checks. Read tools and other host
path contracts remain absolute.

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
`inspect_paths` reports the four-digit octal and nine-character symbolic Unix
permission bits returned by `lstat` without exposing file contents. Those
exact values remain attached to the current-run verified path outcome for
validation.
Existing file-size, traversal, depth, entry-count, and
model-facing output bounds still apply. Searches with omitted roots default to
`<AYATI_ROOT_DIR>/workspace/`; broader discovery requires explicit roots.

`search_in_files` uses `resultMode: "paths"` by default. Its model-facing
observation contains matching canonical paths and line numbers but no matching
or neighboring text. A caller may explicitly request `resultMode: "snippets"`
when the user's task needs content, or `resultMode: "count"` for an exact
occurrence total without returned matching text. Every result separates
`returnedMatchCount` from `totalMatchCount`; sampled positive searches report
`totalMatchCount: null` and `countComplete: false`. Count mode reports an exact
total only after the complete allowed scope was scanned without skipped files.
The full structured result remains available to deterministic verification and
durable evidence storage.

An ordinary content search that exhaustively returns zero matches is also an
exact zero count. It produces the same typed `file.search_count` proof as count
mode, so an absence question can finish without rerunning the search. A zero
from incomplete coverage remains supporting information only.

`find_files` searches path names and accepts `kind: "file" | "directory" |
"symlink" | "any"`, defaulting to `"any"`. Every match carries its name,
canonical absolute path, and actual kind. Symbolic links are returned as
`kind: "symlink"`; discovery never follows a symbolic-link directory while
walking the tree. A directory match is therefore an exact verified path
observation and does not require a second metadata call merely to establish
that the directory exists. Complete zero-match evidence also retains the
requested kind; a no-file result cannot be reused as proof that no matching
directory or symbolic link exists.

`list_directory` uses the same `file | directory | symlink | other` entry
kinds and does not recurse through symbolic links. `inspect_paths` keeps
`lstat` metadata for the link itself and reports bounded resolved-target
metadata (`targetPath`, `targetKind`, and `targetExists`) without reading
target content. A later `read_files`, `list_directory`, or mutation call still
passes the normal resolved-target access and authority checks.

Tool choice follows the observed kind: `read_files` reads regular-file
content, `list_directory` lists directory entries, and `inspect_paths` answers
metadata questions or resolves an uncertain kind. A wrong-tool rejection
names the observed kind and the correct tool so the next decision can recover
without another discovery cycle.

Machine-read authority grants no workstream ownership or mutation authority.
With `mutationScope=workspace`, each relative direct-filesystem effect is first
resolved beneath `<AYATI_ROOT_DIR>/workspace/`; absolute effects remain
unchanged, and other mutation-capable tools retain their declared absolute-path
contracts. Every result is canonicalized before resource lookup, mutation
preparation, temporary-file creation, or execution. External and traversal
paths fail with `PATH_OUTSIDE_MUTATION_WORKSPACE`. Both move endpoints must be
inside, symbolic-link escapes are rejected, and `allowExternalPath` cannot
override policy.

Inside-workspace location is necessary, not sufficient. Mutation still
requires immutable workstream binding, an exact selected destination, declared
targets, and post-operation verification. Narrow selected-root filesystem
mutation does not require a pre-created resource row or per-file mutate
binding. The optional operator value `mutationScope=bound_resource` restores
the older resource-scoped mutation journal for deployments that require it.

Mode transitions keep search subjects, read-only references, existing routed
resource IDs, bound execute mutation scopes, and new `workspaceTargets` in
separate typed fields. A reference path cannot become mutation authority
merely because it is absolute. The model-facing activation control accepts
only the observed workstream, request lifecycle choice, and exact resource
IDs. The runtime uses those IDs to ground activation, then derives ownership,
repository HEAD, evidence, and every usable mutation root from the
authoritative activated workstream bindings. It includes only absolute
filesystem bindings already marked `mutate` and excludes missing or deleted
resources; a narrower user-stated turn boundary still applies. The
model-facing create control accepts only:

```text
purpose
capabilities
references?            # read-only context only
workspaceTargets[]     # { kind, relativePath }
binding                # title, objective, initialRequest contract
```

The runtime injects `kind: create`, derives current-run routing evidence,
resolves absolute target paths, inspects exact resource identities, and binds
only those resources. Mutation directory containment is checked on canonical
paths, including missing future children through their nearest existing
ancestor, and rejects symbolic-link escapes.

Selected-root `create_directory`, `write_files`, `patch_files`, `copy`, `move`,
`delete`, and `set_permissions` calls use bounded target-local effect
verification. The executor captures the exact declared target entries,
executes the focused tool, and checks the status-specific target transitions.
The tool implementation itself has no general command surface: it can change
only its explicit target paths and any requested missing destination parents.
Reported parent creation and deferred delete-cleanup paths are checked
separately. The generic verifier does not scan siblings, walk the whole
project, or query repository-wide Git state.

Repository-wide Git reads are available only through the Context Engine's
managed workstream-history tools. They accept the exact projected shared
workstream repository path and bounded commit/count inputs. The engine checks
the real repository root, `main` branch, and SQLite-tracked HEAD. Log, show,
and diff are read-only, cannot address the user project repository, and
produce navigation facts rather than mutation authority.

That division is deliberate. It avoids a 20,000-entry or 512-MB project
snapshot for a one-file edit while keeping the important proof local:
before-state preconditions, atomic replacement where possible, truthful
partial outcomes, and final target state. The daemon-wide FIFO run queue
prevents two Ayati runs from interleaving these operations. External programs
that write independently remain outside this in-process guarantee.

`write_files` is a desired-state UTF-8 text operation. Its model-facing input
contains only canonical absolute paths, complete desired content, and optional
`createParents` (default `true`). The runtime supplies target preconditions
internally; the model never copies resource ids, permission tokens, or content
hashes into the call. Missing files become `created`, different regular files
become `replaced`, and matching files succeed as `unchanged`.

Changed content is staged in an exclusively created temporary file in the
destination directory, every target is rechecked against its captured
before-state, and each staged file is renamed into place. One file replacement
is atomic, but a multi-file call is not a filesystem transaction. If a later
rename fails, the result reports the committed and failed paths exactly; the
same desired-state call can be retried because already-current files become
`unchanged`. The target-local verifier owns the final physical content hash
check, so the generic tool contract does not read and hash every file again.

`patch_files` applies ordered exact text or line patches to existing bounded
UTF-8 files. The runtime supplies before-state preconditions internally. The
tool rejects stale targets, duplicate canonical paths, symbolic links, hard
links, oversized inputs, and invalid UTF-8 before replacement. Approximate
whitespace or punctuation matches are diagnostics only; they never authorize
a mutation. Patched content is staged beside each target with its existing
mode, every target is rechecked, and replacements are renamed sequentially.
The result reports each committed or failed file, including partial calls, and
the target-local verifier owns the single final physical hash and metadata
check. Patch instructions are not generally idempotent, so a partial call is
never advertised as safe for automatic identical retry.

`create_directory` accepts one absolute directory path. Existing directories
return `already_exists`; a non-directory at the path is a conflict. Recursive
creation reports every parent that now exists because of the call. If only
some parents are created before failure, the result is `partial` and names
them.

`copy` accepts one source and one missing destination. The source is read-only
and may be outside the selected destination root. Files, directories, and
symbolic links are copied without following the final symbolic link. The tool
stages beside the destination, verifies a bounded deterministic fingerprint,
then renames the staged entry into place. It never overwrites an existing
destination.

`move` accepts one contained source and destination and is classified as
destructive because success removes the source. A same-filesystem move uses
rename. A cross-filesystem move copies to a staged destination, verifies it,
rechecks that the source has not changed, and only then removes the source. If
source removal fails, the result explicitly reports
`copied_but_source_retained`; it never claims that the move completed.

`delete` uses final-entry semantics: deleting a symbolic link unlinks the link,
not its target. Missing targets return `already_absent`. A directory requires
explicit recursive intent. Recursive deletion first renames the target to a
private sibling, making the requested path absent atomically, and then removes
the private entry. Cleanup failure returns `cleanup_pending` with the exact
remaining path.

`set_permissions` changes exact octal modes on up to 16 regular files. It
rejects symbolic links and hard-linked files, rechecks each before state,
preserves content and inode identity, and reports changed, unchanged, or
failed status per file. Like other multi-target calls, it executes
sequentially and reports a truthful partial result.

Finite `process_run` and Python mutation-capable calls declare an
inside-workspace working directory and exact inside-workspace effect targets.
Mutable database calls declare an inside-workspace database destination, and
dataset promotion declares an inside-workspace target database. Calls without
enough declared target information fail closed. Background `process_start`
and `process_send_input` do not accept filesystem target claims because their
effects can outlive a single tool result; they cannot provide focused
filesystem completion evidence. Use focused filesystem tools for mutations
and bounded `process_run` for commands whose completion can be checked.

For a new workstream, finite `process_run` may use the exact current-run
creation scope before the new files have durable resource records. The
executor still requires explicit targets, contains the working directory and
targets within one selected scope, and observes those targets before and after
the command. A successful command may leave an existing validation target
unchanged; a failed command must not change a declared target. Durable
resource registration remains a finalization responsibility.

These declarations are Ayati's authorization contract, not an operating-system
sandbox around arbitrary native or Python code. A deployment requiring
host-enforced containment must separately sandbox or disable those
general-purpose execution tools.

## Workstream Controls

The primary model uses these read-only observations in the ordinary
observation modes for both workstream questions and mutation routing:

- `git_context_find_workstreams`
- `git_context_read_workstream`
- `git_context_find_resources`

Their capability ids are `workstream:search`, `workstream:read`, and
`resource:ownership`. All three calls remain routing observations. Workstream
search and resource-owner lookup are routing-only. A successful exact
`git_context_read_workstream` call additionally emits one typed
`workstream.snapshot_read` completion outcome so a read-only enquiry can
validate the committed snapshot it used. That outcome proves only the exact
snapshot read; it does not prove filesystem contents, a mutation, or request
completion.

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

Reading never binds. Workstream search and resource-owner lookup run in
`observe.locate`; exact workstream reads run in `observe.investigate`. An
unbound mutation cannot move directly from `ENTRY` to `workstream.route` or
`resolve`. One of the observations above must first succeed in the current
run. That evidence unlocks the control-only route stage, which has no
executable tools and can either proceed to resolve or return to observation.
The runtime then validates the typed proposal and invokes one atomic Context
Engine binding operation without a model call. Existing activation requires
observed resource IDs and a lifecycle choice; the runtime validates
activation, repository HEAD, and evidence, then mounts all eligible
authoritative mutable filesystem bindings. New creation requires typed
workspace targets; the runtime derives their absolute paths, evidence
references, and resource ids. It then enters `execute` mechanically before
asking for a fresh decision. Routing an existing workstream must explicitly
continue, amend, activate, resume, create, or atomically defer and switch its
request.
Replay identity derives from the existing run id and deterministic gate id.
An ambiguity that performs no binding consumes no mutation-safe binding
authority. A request-lifecycle rejection recorded before any route plan or
run binding permits one corrected proposal; a second no-change rejection or
any uncertain failure closes binding for the run. An explicit create-new
instruction or an exact follow-up choice to the prior durable question
bypasses semantic reuse suggestions; authoritative resource checks still
apply.

## Calculator

`calculator` is a targetless read-only tool in `observe.investigate`. It
evaluates bounded real-valued expressions with 50-significant-digit decimal
arithmetic and returns the result as a string so JavaScript number conversion
does not discard precision. Trigonometric arguments use radians. The model
should prefer explicit `*`; implicit multiplication remains supported with
ordinary exponent precedence.

The calculator accepts only its own numeric grammar and known functions. It
does not evaluate JavaScript or invoke a process. Deterministic limits bound
expression length, token count, nesting, numeric-literal size, power
exponents, and expensive transcendental arguments. Non-real, non-finite, and
over-limit calculations are typed failures and never produce completion
proof. Successful contracts require a finite result and emit both the exact
expression outcome and a supporting result fact. Final validation reuses the
verified current-run outcome without invoking the calculator again.

## System Observations

Two runtime-created, read-only tools provide fresh local observations without
a workstream or resource target:

- `system_time` returns the current UTC timestamp, configured or requested IANA
  timezone, local date and time, weekday, and UTC offset.
- `system_health` returns a bounded snapshot of CPU load, memory availability,
  the volume containing Ayati's data root, system uptime, and Ayati process
  memory.

For `system_time`, local, machine-local, and Ayati-local requests omit the
timezone argument and use Ayati's configured timezone. The model supplies an
IANA timezone only when the user explicitly requests that timezone or a
particular location. Tool-schema examples must not introduce an unrelated
timezone into an otherwise local request.

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

A profile or exact slice may prove a deliberately bounded overview when the
response is qualified to that observed coverage. It cannot prove exhaustive
claims about unread content. Current matching outcomes are reused by
`outcomeRef`; only insufficient coverage or later verified mutation requires
another observation.

The validation request uses `{ outcomeRefs: string[] }`. Each value must be an
exact reference copied from `context.run.verifiedOutcomes`. The runtime—not
the model—resolves every reference into
`{ kind, subject, expectedKind?, searchScope?, readScope?, denialCode? }` and
writes the satisfying run/step/call reference into the check result. A later filesystem
mutation invalidates stale path/read proof and affected no-match searches. A
deterministic runtime-check call
may expose `tool.call_succeeded` by exact `callId` only when no stronger typed
outcome exists. A deterministically rejected permission call may expose
`tool.call_denied` by exact `callId` and stable `denialCode` only when the call
did not perform the requested operation. That proves the denial, never a read
or mutation success. Historical calls cannot satisfy task validation.
Routing-only outcomes from workstream search and resource-owner lookup also
remain ineligible. An exact current-run workstream read is dual-purpose: its
routing receipt stays routing-scoped, while only its separately typed
`workstream.snapshot_read` outcome is selectable for read-only validation.
Unknown, cross-run, supporting, other routing-only, and invalidated references
are rejected. The decision model sees descriptive proof fields in the compact
projection, but selects only its exact opaque `outcomeRef` values.

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
