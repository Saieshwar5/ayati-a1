# Testing Strategy

Tests use Vitest. Prefer deterministic local tests and mocked provider or
external-system boundaries unless a test is explicitly live acceptance.

## Package Responsibilities

- `ayati-context-engine/tests`: V8 contracts/schema, stream/run lifecycle,
  checkpoints, exact history, workstreams, resources, finalization, archive
  safety, and recovery.
- `ayati-main/tests`: agent-facing lanes, pressure compilation, checkpoint
  generation, history tools, memory boundaries, capability policy, resource-
  scoped execution, feedback, transports, and daemon integration.
- `ayati-cli/src/app/**/*.test.ts*`: terminal input/rendering, commands,
  attachments, and transport envelopes.

## V8 Context Invariants

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
11. Finalization appends at most one assistant message, closes the run
    truthfully, creates at most one context commit, and never stages
    deliverables.
12. Restart/recovery preserves verified dirty resource state and blocks unsafe
    continuation.
13. Context Engine is the serialization owner. Step persistence returns the
    updated authoritative projection without a harness-side reread or cache.
14. Workstream and resource-owner discovery run as read-only primary-loop
    observations. They produce exact current-run routing references but cannot
    satisfy task-completion evidence.
15. The deterministic resolve gate makes zero model calls, accepts one typed
    activate-or-create proposal, rechecks authoritative candidate/resource
    state, and binds at most one workstream/request on the existing run.
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
    validation-ready completion proofs and is rebuildable from the durable
    call journal. Accepted terminal completion promotes at most four selected
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
22. Observation modes expose only read-only effects, mode changes replace the
    complete tool surface, and execute cannot re-enter resolution.
23. Passed validation unlocks a direct final response. Failed checks preserve
    the graph for repair, while `decision_stop` is reserved for supported
    needs-input, blocked, or failed outcomes.
    A conclusive zero-match filename search is validated as
    `file.search_no_match`, not classified as blocked. Its proof must be
    uncapped, error-free, depth-complete, and tied to the exact search scope.
    Passed validation resolves an earlier validation-scoped terminal repair
    without clearing real action, binding, or permission failures.
24. Host filesystem fields reject relative paths and file URIs. Resource child
    fields stay explicitly relative, pair with a resource id, and reject
    containment escapes.
25. Directory mutation authority includes canonical descendants but not
    siblings or symbolic-link escapes. Read-only references never become
    mutation candidates.
26. Explicit create-new ownership survives a focused clarification; ambiguity
    without a binding does not consume the single binding attempt.
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
30. The recent-document registry is rebuilt from exact verified complete-read
    steps, deduplicates and caps at 32 paths, projects only five lightweight
    active pointers into the Core Capsule, exposes only the remaining 27
    through `files.recent`, preserves both views through restart/checkpoint
    projection, and grounds read-only investigation without granting mutation
    authority or current-content proof.
31. `system:time` and `system:health` enter investigation without a resource
    reference, while target-backed or mixed investigation capabilities still
    require one. Their outputs are bounded, privacy-safe, contract-verified,
    and become typed current-run validation outcomes without a second sample.

## Prompt and Harness Coverage

Test zero-step `ENTRY` conversation and clarification replies, every
virtual-graph edge, exact target provenance, read-only observation surfaces,
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
that old-mode tools disappear, prove one fresh primary decision follows a
successful binding, and assert the expected primary-model request count. No
resolver pressure profile, private history, private semantic usage, or second
context-preparation lane exists.

## Reset Testing

V8 has no older-schema compatibility reader. Archive/reset tests verify that dry run is
non-mutating, a live writer is refused, database/WAL/SHM plus managed
resources and workstreams are archived, workspace output is preserved, and
the manifest records the detected archived schema and the V8 target.

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
