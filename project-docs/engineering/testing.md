# Testing Strategy

Tests use Vitest. Prefer deterministic local tests and mocked provider or
external-system boundaries unless a test is explicitly live acceptance.

## Package Responsibilities

- `ayati-git-context/tests`: protocol/schema, atomic preparation, workstream
  repositories, requests, resources, discovery, steps, mutation verification,
  finalization, rebuild, archive safety, and recovery.
- `ayati-main/tests`: model-facing controls, capability policy, resource-scoped
  execution, harness behavior, context projection, feedback, transports,
  memory, and daemon integration.
- `ayati-cli/src/app/**/*.test.ts*`: terminal input/rendering, commands,
  attachments, and transport envelopes.

## Durable-Work Coverage

Changes should prove the relevant invariants:

1. Preparation atomically creates one message, conversation, run, and
   WorkState; replay returns the same identities.
2. Binding preserves run id and cannot switch workstream/request.
3. Context repositories contain only `workstream.md`, requests, and
   `resources.json`; real output stays at resource locators.
4. Discovery explains exact identity, resource owner, continuation, text,
   unfinished, star, recent, and frequent signals without granting authority.
5. User attachments are immutable managed resources; referenced paths stay in
   place.
6. Each resource has at most one canonical binding per workstream; request
   roles and finalization replay cannot duplicate workstream ownership.
7. Unbound mutation is rejected. Bound mutation requires exact mutable
   resources and verified before/after observations.
8. Step replay does not duplicate step count or WorkState revision.
9. Finalization creates at most one context commit and never stages
   deliverables.
10. Every terminal outcome persists truthful status and stop reason.
11. Restart/recovery preserves verified dirty resource state and blocks unsafe
   continuation.

## Harness Coverage

Test direct zero-step replies, observational runs, observation followed by
binding on the same run, stale mutation repair without replay, context refresh
before a fresh decision, accepted completion, clarification, all terminal
outcomes, and final acknowledgement ordering.

Prompt snapshots must expose WorkState, current ordered calls, and pressure but
not internal run/storage paths, verbose runtime modes, routing counters, or
deferred mutation.

## Live Acceptance

Run an isolated daemon with feedback tracing. Exercise conversation,
workspace/resource reads, ambiguous ownership, new workstream creation,
resource mutation, continuation, switching among several workstreams, and
interruption before/during finalization.

For each turn inspect final UX, raw trace, latest/triage summaries, run/step and
resource rows, reusable read context, context Git, real resources, and restart
behavior. Report newly discovered bugs before making unrelated follow-up edits.

## Commands

```bash
pnpm --filter ayati-git-context test
pnpm --filter ayati-main test
pnpm --filter ayati-cli test
pnpm test

pnpm --filter ayati-git-context build
pnpm --filter ayati-main build
pnpm build
```
