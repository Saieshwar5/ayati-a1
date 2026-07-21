# Testing Strategy

Tests use Vitest. Prefer deterministic local tests and mocked provider or
external-system boundaries unless a test is explicitly live acceptance.

## Package Responsibilities

- `ayati-context-engine/tests`: V7 contracts/schema, stream/run lifecycle,
  checkpoints, history, observations, workstreams, resources, finalization,
  archive safety, and recovery.
- `ayati-main/tests`: agent-facing lanes, pressure compilation, checkpoint
  generation, history tools, memory boundaries, capability policy, resource-
  scoped execution, feedback, transports, and daemon integration.
- `ayati-cli/src/app/**/*.test.ts*`: terminal input/rendering, commands,
  attachments, and transport envelopes.

## V7 Context Invariants

Changes should prove the relevant invariants:

1. Preparation atomically resolves one agent stream and creates one immutable
   ingress message, run, and WorkState; replay returns the same identities.
2. All local clients and system events use `local/default` continuity unless a
   caller explicitly selects another stream scope.
3. Message update/delete fails and sequence is monotonic per stream.
4. Run context contains structured steps and WorkState; stream projection does
   not duplicate action logs. The exact current-input content appears once in
   the temporal lane; the current lane contains only identity and routing.
5. Binding preserves run id and cannot switch workstream/request.
6. Successful list/search/read calls may create reusable observations;
   mutations cannot. A resource-version change invalidates affected entries.
7. History search defaults to 10 and caps at 25; reads cap at 50 messages and
   32,000 characters and return deterministic continuations.
8. A checkpoint is planned only under pressure, covers complete terminal runs,
   preserves the current input, validates exact anchors, and atomically moves
   the active pointer.
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
14. Workstream resolution has a separate bounded journal and WorkState-like
    state; it never increments main run steps or changes main WorkState.
15. Resolution binds at most one workstream/request, exposes no more than five
    candidates to the main loop, records full private steps/usage, and marks an
    unfinished activity interrupted rather than resuming it after restart.
16. Completion remains a deterministic gate. Resolver activity and legacy
    routing controls cannot satisfy task-completion evidence.

## Prompt and Harness Coverage

Test direct zero-step replies, observational runs, isolated resolution followed
by binding on the same run, resolver ambiguity/failure/limits/parallel ordering,
stale mutation repair without replay, context refresh before a new decision,
accepted and rejected completion, all terminal outcomes, and final
acknowledgement ordering.

Prompt snapshots must expose temporal/current/stream/work/resources/
observations/personal/tools/harness/run lanes. They must exclude internal
storage paths, observation authority fields, idempotency state, and reusable
action context.

Pressure tests must measure the whole candidate and prove recovery order:
tool compaction, deterministic stream projection, durable checkpoint, final
remeasurement.

## Reset Testing

V7 has no older-schema compatibility reader. Archive/reset tests verify that dry run is
non-mutating, a live writer is refused, database/WAL/SHM plus managed
resources and workstreams are archived, workspace output is preserved, and
the manifest identifies the archived-to-V7 boundary.

## Live Acceptance

Run an isolated daemon with feedback tracing. Exercise conversation across
multiple clients, system events, resource reads, ambiguous ownership, new
workstream creation, mutation, continuation, pressure checkpointing, exact
history recovery, and restart behavior.

Inspect final UX, raw trace, run/step/resource rows, checkpoint anchors,
observations, personal-memory jobs, context Git, real resources, and terminal
acknowledgement ordering.

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
