# Testing Strategy

Tests use Vitest. Prefer deterministic local tests and mocked provider or
external-system boundaries unless a test is explicitly live acceptance.

## Package Responsibilities

- `ayati-context-engine/tests`: V9 contracts/schema, stream/run lifecycle,
  checkpoints, exact history, workstreams, resources, finalization, archive
  safety, and recovery.
- `ayati-main/tests`: agent-facing lanes, pressure compilation, checkpoint
  generation, history tools, memory boundaries, capability policy, resource-
  scoped execution, feedback, transports, and daemon integration.
- `ayati-cli/src/app/**/*.test.ts*`: terminal input/rendering, commands,
  attachments, and transport envelopes.

## V9 Context Invariants

Changes should prove the relevant invariants:

1. Preparation atomically resolves one agent stream and creates one immutable
   ingress message, run, and WorkState; replay returns the same identities.
2. All local clients and system events use `local/default` continuity unless a
   caller explicitly selects another stream scope.
3. Message update/delete fails and sequence is monotonic per stream.
4. Run context contains structured steps and WorkState; stream projection does
   not duplicate action logs. The exact current-input content appears once in
   `context.core.current`; historical continuity is independently bounded by
   complete turns.
5. Binding preserves run id and cannot switch workstream/request.
6. Step persistence creates no cross-run observation record. Exact tool
   evidence remains in its authoritative run journal and bounded history
   search returns stable run/step/call references directly from that journal.
7. History search defaults to 10 and caps at 25; reads cap at 50 messages and
   32,000 characters and return deterministic continuations.
8. A checkpoint is planned only for Core Capsule maintenance or measured
   whole-request pressure, covers complete terminal runs, preserves the current
   input, validates exact anchors, and atomically moves the active pointer.
9. Checkpoint generation permits one repair and a failed generation does not
   mutate durable state.
10. Personal-memory extraction consumes only the newly committed checkpoint's
    exact user/assistant range.
11. Finalization appends at most one assistant message and closes the run
    truthfully. Every finalized bound run appends exactly one progress entry
    and creates exactly one shared-repository commit; unbound runs create
    neither. Deliverables are never staged.
12. Restart/recovery preserves verified dirty resource state and blocks unsafe
    continuation.
13. Context Engine is the serialization owner. Step persistence returns the
    updated authoritative projection without a harness-side reread or cache.
14. An unbound mutation first observes ownership through workstream search or
    resource-owner lookup in `observe.locate`, or exact workstream read in
    `observe.investigate`. Those calls produce exact routing references but
    cannot satisfy task-completion evidence. A successful current-run
    observation unlocks control-only `workstream.route`, whose surface is
    empty. Direct `ENTRY -> workstream.route`, `ENTRY -> resolve`, and
    observation-to-resolve transitions are unavailable. Route may return to
    observation or proceed to resolve.
15. The deterministic resolve gate makes zero model calls, accepts one typed
    continuation, amendment, activation, resumption, creation, defer-and-switch,
    or new-workstream proposal, rechecks authoritative candidate/resource
    state, and binds at most one workstream/request on the existing run. One
    corrected proposal is allowed only after a retryable rejection explicitly
    recorded before any route plan or binding; all uncertain failures close
    binding immediately.
16. Whole-task validation is a stored proof-only mode with no executable
    tools. It checks a small absolute-path checklist against compact completion
    evidence emitted by deterministically verified current-run calls; it does
    not repeat reads, replay all steps, or accept routing observations and
    hidden lifecycle controls as completion. Complete-read checks require
    explicit complete coverage and fail after a later mutation until the file
    is read again. Scoped-read checks separately cover exact untruncated
    slices, searches, and profiles; truncated output, narrower ranges,
    different queries, and later mutations must fail.
    Model-facing calls retain their useful exact normal inputs and outputs but
    replace detailed verification and completion-evidence objects with one
    verification-status scalar. A separate exact
    `context.run.verifiedOutcomes` projection contains only current
    validation-ready completion proofs, gives each one a stable exact
    `outcomeRef`, and is rebuildable from the durable call journal. The model
    selects only these references; tests must reject fabricated, cross-run,
    routing-only, supporting, duplicate, and stale references. Accepted
    terminal completion promotes at most four selected
    passed checks into bounded WorkState receipts with exact proof references;
    failed checks and raw verifier payloads are excluded.
17. Context candidates are disposable, lane-scoped, source-hashed, and valid
    across append-only tail growth only. Restart loses no authoritative data.
18. Background semantic work has one provider-scoped slot, never blocks
    foreground work below the forced barrier, and records failed/rejected
    usage exactly once.
19. Durable checkpoint generation does not commit. Adoption revalidates and
    rebuilds from the fresh Context Engine commit projection.
20. A run focus summary anchors every statement, stays within 1,600
    estimated tokens and one repair, and cannot replace current input,
    authority, failures, WorkState, or completion evidence.
21. Every run begins at `ENTRY`; virtual modes never survive finalization,
    interruption, restart, or the next accepted input.
22. Observation modes expose only read-only effects. `workstream.route`
    exposes no executable effects and clears the observation tool surface.
    Mode changes replace the complete tool surface, and execute cannot
    re-enter routing or resolution.
23. Passed validation unlocks a direct final response. Failed checks preserve
    the graph for repair, while `decision_stop` is reserved for supported
    needs-input, blocked, or failed outcomes.
    A conclusive zero-match filename search is validated as
    `file.search_no_match`, not classified as blocked. Its proof must be
    uncapped, error-free, depth-complete, and tied to the exact search scope.
    Passed validation resolves an earlier validation-scoped terminal repair
    without clearing real action, binding, or permission failures unless an
    exact passed `tool.call_denied` check accounts for its own permission call.
24. Read-only host references and existing mutation scopes reject relative
    paths and file URIs. Resource children remain explicitly relative to a
    resource id. New-workstream targets instead require `{ kind,
    relativePath }` beneath the configured workspace. Direct filesystem
    mutation tools accept absolute workspace paths or workspace-relative
    paths, which the executor resolves once before all normal gates. The five
    core filesystem observation tools accept explicit machine paths in bound
    and unbound runs when read scope is `machine`; omitted search roots remain
    workspace-local, host permission failures return no content, and
    non-regular devices are not normal files.
25. A focused filesystem call uses runtime-derived destination authority.
    `write_files` and `patch_files` may batch across several separately
    selected roots only after every target maps to one root before execution;
    one unmatched target rejects the complete batch. Other focused mutation
    tools retain one destination root. Canonical descendants are allowed,
    siblings and symbolic-link escapes are rejected, and a copy source is
    read-only. Workspace-relative paths resolve once beneath the configured
    workspace; external absolute destinations require an exact routed bound
    resource. Process/Python and other broad effects retain resource-scoped
    preparation. Existing-workstream activation mounts every distinct absolute
    filesystem binding already marked `mutate`, excluding read-only, missing,
    deleted, non-filesystem, and relative locators. A narrower filesystem
    boundary in the current user message filters those roots.
26. Explicit create-new ownership survives a focused clarification; ambiguity
    without a binding consumes no binding authority. A lifecycle-state
    rejection proven to have made no change permits one corrected resolve
    proposal, while a second rejection closes binding for the run.
27. File-content validation rejects a silently substituted source.
28. Assistant response/feedback kinds survive finalization and restart, while
    attachment resource identities remain associated only with their exact
    user-message sequence. Core Capsule projection preserves both without
    creating an automatic adjacency-based reply binding.
29. `workstates.recent` is absent when no material terminal handoff exists,
    advertises metadata without WorkState content, loads content only on
    explicit request, excludes active/recovery/initial and trivial completed
    records, orders newest first, caps at five distinct runs, and remains
    historical advisory context rather than authority or completion evidence.
    A terminal WorkState summary never copies the full assistant response: it
    preserves a meaningful checkpoint or derives a compact deterministic
    handoff.
30. The recent-document registry is rebuilt only from exact verified successful
    complete-read steps belonging to stable terminal runs. It preserves valid
    reads from done, incomplete, failed, blocked, and needs-input outcomes while
    excluding running/recovery-required runs and failed or unverified calls. It
    deduplicates and caps at 32 paths, projects only five lightweight active
    pointers into the Core Capsule, exposes only the remaining 27 through
    `files.recent`, and preserves both views through restart/checkpoint
    projection. These are navigation pointers, not read admission, mutation
    authority, or current-content proof.
31. `system:time` and `system:health` enter investigation without a resource
    reference, while target-backed or mixed investigation capabilities still
    require one. An exact filesystem-only `file:read` reference may enter
    without earlier grounding evidence; its tool boundary still validates the
    path, policy, file type, content, and read result. Other target-backed
    references retain provenance checks. System outputs are bounded,
    privacy-safe, contract-verified, and become typed current-run validation
    outcomes without a second sample.
32. A verified multi-match `find_files` call projects a bounded factual
    candidate set through normal and compacted tool-call context while keeping
    private projection metadata hidden. Candidate choice and clarification
    remain model-driven; the runtime does not classify natural-language
    selections.
33. A whole assistant-text JSON object matching the required top-level
    signature of a currently exposed native control is never accepted as a
    direct reply or executed automatically. The harness requests one native
    tool-call repair, while unrelated JSON assistant replies remain valid.
    Provider tool choice is `auto` only when `normal_reply` is graph-legal;
    active graph states require one native tool call, and a known repair target
    may pin only a native tool that remains exposed.
34. A failed permission call produces `tool.call_denied` only with exact call
    identity, stable denial code, and deterministic evidence that the requested
    operation did not occur. Exact denial validation resolves only the matching
    action failure as `denial_reported`; unrelated failures remain active, the
    step remains failed, and denial cannot satisfy any success outcome.
35. Filesystem policy defaults and environment overrides are strict and
    model-independent: machine reads do not grant binding or mutation
    authority, focused filesystem mutation still requires workstream binding,
    a selected root, containment, and target-local verification, and
    `bound_resource` can be restored only by operator configuration.
36. Requests use only `queued`, `active`, `blocked`, `done`, and `dropped`.
    At most one is active per workstream; `done` and `dropped` are terminal.
    Incomplete and failed runs do not rewrite the request file. Contract
    amendment preserves request identity, path, and creation time, and trusted
    policy cannot silently remove acceptance criteria. Completion evidence
    must represent every acceptance criterion in the bound request.
37. Shared Git has exactly one `.git/` beneath `workstreams/`. A commit to one
    `W-*` path changes global HEAD without changing another workstream's
    path-specific last commit or making it stale.
38. Activation loads at most the five newest progress entries for the run's
    selected request. Older progress remains searchable and rebuildable.
39. Finalization recovery retries an exact journal before a commit and
    acknowledges an already-created commit by `Ayati-Run` trailer without
    duplicating either progress or Git history. Recovery completes partial
    journaled file writes and cleans only matching abandoned atomic temp files;
    unrelated dirt is preserved and rejected. Restart cleanup removes only
    unbound, uncommitted provisional workstreams and retains bound provisional
    state for finalization recovery.
40. Nested-repository migration is preview-first, refuses dirty or
    non-context repositories, preserves originals in an archive, converts v2
    cards and requests, creates an empty progress baseline when the legacy
    ledger is absent, creates one shared baseline commit, and rebuilds an empty
    V9 catalog.
41. Request FTS participates in workstream discovery for terminal as well as
    unfinished requests. An exact historical-request read returns its final
    outcome and at most five recent progress entries without binding the run
    or reopening the request.
42. Every bound primary-model prompt contains the exact selected request
    contract and distilled workstream context. A different active request is
    identified without replacing the selected request; progress is limited to
    the five newest selected-request summaries. At most ten deterministic
    resource metadata records include identity, display metadata, public
    locator, role, access, availability, primary status, and request relevance;
    an omitted count preserves boundedness. Binding/request mismatches fail
    closed, while resource contents, versions, hashes, commits, raw logs,
    unrelated requests, and complete history stay outside the prompt.
    WorkState does not repeat workstream or request identity. Context-pressure
    projection preserves the bound-workstream lane exactly.
43. Every primary-model prompt contains the exact configured absolute
    `context.run.workspaceRoot` once. Chat and actionable system-event runs use
    the same runtime value; prompt compaction and post-binding refresh preserve
    it. The model treats workspace aliases and relative output destinations as
    this location without rediscovery or repeating the root in a creation
    call. Creation declares exact typed workspace-relative targets; the runtime
    derives canonical absolute roots and current-run routing evidence without
    pre-registering a missing resource. Normal binding, containment, and
    verification gates remain required.
44. `decision_resolve_create` exposes no creation `kind`, absolute mutation
    scope, resource id, or evidence field. Its native schema deeply validates
    every workspace target and the complete initial-request contract before
    dispatch. Invalid nested fields receive one bounded repair and never reach
    the deterministic graph. `decision_resolve_activate` exposes only the
    observed workstream, request lifecycle choice, and exact routed resource
    IDs. The runtime grounds activation with those IDs, then derives eligible
    mutable roots from authoritative activated bindings, repository HEAD, and
    evidence, and rejects stale or mismatched state. Read-only, missing, and
    deleted resources never become mutation roots.
45. `create_directory`, `write_files`, `patch_files`, `copy`, `move`,
    `delete`, and `set_permissions` report exact completed, unchanged,
    partial, and failed target effects. The verifier re-observes only declared
    targets and reported parent/cleanup paths, rejects stale preconditions, and
    never accepts tool prose as mutation truth.
46. Verified filesystem effects enter resource lifecycle finalization
    independently of the larger run outcome. Create/restore, modify,
    permission change, move, copy, and delete preserve the correct identities,
    former locators, tombstones, versions, and fallback/enriched metadata.
47. Chat and system-event entry share one FIFO agent-run queue. A later input
    cannot prepare or execute while an earlier run still owns target-local
    verification, and shutdown drains the queue.

## Prompt and Harness Coverage

Test zero-step `ENTRY` conversation and clarification replies, every
virtual-graph edge, exact target provenance and the narrow self-validating
filesystem-read exception, read-only observation surfaces,
capability-surface replacement, active-graph direct-response guarding, and
identical self-transition no-progress stopping. Also
test the absence of a second model loop, main-loop workstream observation,
typed binding-proposal provenance, deterministic binding followed by
mechanical execute entry on the same run, ambiguity and failure outcomes,
single-attempt enforcement, stale HEAD and invented-target rejection, stale
mutation rejection without replay, context refresh before a fresh decision,
pending, passed, and failed validation checks, every terminal stop outcome,
exact current-run filesystem and semantic outcome checks, routing-proof
exclusion, observation WorkState completeness,
mutation-validation bypass prevention, filesystem path/type/format checks,
machine-read/workspace-mutation scope separation, external symlink reads,
cross-boundary mutation denial, exact denial evidence and failure accounting,
evidence-backed clarification, and final acknowledgement ordering. Assert
that the resolve gate does not invoke a provider and does not create a task
step.

Prompt snapshots must expose only core/hot/tools/harness/run lanes. Core
snapshots must preserve exact sequence identity, assistant response semantics,
and per-message attachment references. They must exclude work/resource/
observation prompt lanes, the replaced temporal/current/stream prompt objects,
internal storage paths, observation authority fields, idempotency state, and
reusable action context.

Pressure tests must measure the whole candidate and prove recovery order:
recoverable output projection, durable checkpoint, temporary anchored focus
only when necessary, and final whole-request remeasurement. They must
also cover the 55K preparation trigger, predicted-growth trigger, 60K target,
70K soft pressure, local/exact forced barriers, background/foreground overlap,
candidate deduplication/staleness, shadow versus enforce, late completion, and
safe `incomplete/context_limit` termination.

Capability tests must also prove complete registry ownership, duplicate-name
rejection, destination-specific schema enums, authority-aware availability,
whole-surface replacement, complete core coverage, explicit oversize failure,
optional-tool omission receipts, and hidden lifecycle-tool exclusion.

Parallelism tests must prove that queued feedback/report work does not hold the
serialized turn, shutdown and explicit checkpoints drain it, and capture
failure cannot fail execution. They must also prove that a summary candidate
started before binding cannot replace the fresh execute mode, binding
authority, WorkState, routing evidence, failures, or completion evidence.
Below the forced barrier foreground work continues; at the barrier the runtime
may wait once for safe context admission.

Binding tests must distinguish routing evidence from task evidence, verify
that observation tools disappear in the control-only route stage, prove the
route control is hidden before a successful ownership observation, prove
resolve controls appear only inside route, prove route can return to
observation without losing current-run evidence, prove one fresh primary
decision follows a successful binding, and assert the expected primary-model
request count. No resolver pressure profile, private history, private semantic
usage, or second context-preparation lane exists.

## Migration and Reset Testing

V9 has no implicit older-schema compatibility reader. Migration tests verify
that preview is non-mutating, a live writer is refused, every nested
repository is validated, old repositories and database files are archived,
the shared repository and V9 catalog are validated before installation, and a
failed switch restores the original root. Archive/reset tests separately
verify deliberate clean-state recovery while preserving workspace output.

## Live Acceptance

Start the ordinary configured daemon with `pnpm eval:agent -- live`. Exercise
conversation through the real WebSocket/client path across multiple clients,
system events, resource reads, ambiguous ownership, new workstream creation,
mutation, continuation, pressure checkpointing, exact history recovery, and
restart behavior. Use the configured real provider, tools, Context Engine,
memory, resources, schedulers, and background services.

After every terminal response and finalization acknowledgement, inspect the
run evidence/report before choosing the next adaptive message. Inspect final
UX, exact request and tool artifacts, deterministic findings,
run/step/resource rows, checkpoint anchors, personal-memory jobs, context Git,
real resources, and terminal acknowledgement ordering.

Only a recorded real-daemon session is acceptance evidence for Ayati itself.
Instrumentation test doubles and local subsystem benchmarks remain ordinary
developer verification and must not be presented as agent evaluation results.

## Commands

```bash
pnpm --filter ayati-context-engine test
pnpm --filter ayati-main test
pnpm --filter ayati-cli test
pnpm test

pnpm --filter ayati-context-engine build
pnpm --filter ayati-main build
pnpm build
```
