# AYATI-0006 Focus Asset Attachment Restore

## Context

Attachment continuation was stored in two places:

- durable focus-card assets
- a derived active attachment list exposed through prompt memory and context packs

That made follow-up behavior harder to reason about because the model could see a
second attachment surface while the durable continuation thread already lived on
the focus card.

## Changes

- Removed prompt-facing active attachments from memory context, loop state, state
  compaction, and the model context pack.
- Removed prompt-facing `previousSessionSummary` because it had no reliable
  producer and duplicated focus-card, personal-memory, and recall continuation.
- Kept current-run attachments in the sparse state view so fresh uploads remain
  directly usable during the run where the user sent them.
- Made `attachment_restore` resolve directly from focus-card `assets`.
- Supported restore by activated focus card, explicit `focusId`, explicit
  `assetId`, or references such as prepared input id, file id, directory id,
  document id, display name, and path.
- Updated attachment skill activation so focus shelves with artifact hints mount
  attachment, file, document, and dataset tools even when the user sends a
  follow-up without a fresh upload.
- Kept `restore_attachment_context` as a compatibility alias for
  `attachment_restore`.

## Current Contract

The continuation workflow is:

```text
inbound attachment -> current run state/tools -> task summary focusAssets
-> focus-card assets -> focus_activate -> attachment_restore -> current run state/tools
```

Fresh attachments are current-run state. Reusable attachment references are focus
card assets. The context pack contains compact focus shelves, not a separate
active attachment list or previous-session summary.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test -- tests/ivec/agent-loop.test.ts tests/ivec/state-view.test.ts tests/engine/engine.test.ts tests/pulse/proposal-reflection.test.ts tests/ivec/state-persistence.test.ts tests/ivec/focus-continuation.test.ts tests/documents/session-attachment-service.test.ts tests/skills/activation-manager.test.ts
```

Both commands passed. The focused test command currently runs the full backend
Vitest suite through the package script and reported 89 test files passed and 541
tests passed.
