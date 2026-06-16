# AYATI-0004 Focus Card Continuation Assets

## Context

Focus cards are intended to be durable work threads, not only prompt summaries.
The previous implementation showed compact focus cards in `activeFocus`,
`sessionFocusCards`, and `attentionShelf`, but it did not persist enough
restorable state for later runs to continue work that depended on user
attachments or generated artifacts.

The desired boundary is:

- compact shelves help the model select relevant work
- full focus cards store reusable continuation state
- current runs rebuild temporary runtime registries from focus-card assets
- session JSONL remains limited to user/assistant/system activity

## Changes

- Added generic focus-card continuation fields:
  `assets`, `runs`, and `currentState`.
- Added typed asset metadata for:
  user-attached documents/datasets, user-selected files/directories,
  agent-generated artifacts, agent-modified artifacts, and tool results.
- Stored prepared attachment manifest, summary, detail, and restore references
  as focus-card assets so document/dataset tools can be restored in later runs.
- Added exact same-card updates when a task summary carries an active
  continuation `focusId`.
- Kept compact context shelves small. Full card state is loaded through
  focus tools such as `focus_get` and `focus_activate`.
- Made `MemoryManager.getActiveAttachmentRecords()` derive restorable
  attachment records from focus-card assets.
- Reduced tool state updates for restored attachments, indexed documents, and
  staged datasets back into current run state before task-summary publication.
- Updated focus tool prompt guidance to explain compact shelves versus full
  continuation cards.

## Current Contract

Focus cards are stored in `data/memory/memory.sqlite`.

Task summaries create or update focus cards when they include tools, focus
assets, attachment names, or an explicit continuation `focusId`.

The context pack includes only compact shelf items:

- `activeFocus`
- `sessionFocusCards`
- `attentionShelf`

Full card state includes:

- `assets`: durable inputs and work products with origin, role, and restore
  metadata.
- `runs`: compact run history for the work thread.
- `currentState`: resumable state such as goal, open work, key facts, evidence,
  changed files, and working directories.

Activation sets `activeSessionId`, `activatedAt`, and `activatedReason`. The
activation tool returns the full card, and the next task summary updates that
same card when the run completes.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test -- tests/ivec/focus-continuation.test.ts tests/memory/focus-store.test.ts
```

Both commands passed. The focused test command currently runs the full backend
Vitest suite through the package script and reported 89 test files passed and
538 tests passed.

## Follow-Ups

- Add deterministic auto-selection for obvious continuation phrasing when
  exactly one matching focus card exists.
- Add stale asset validation before restoring old file or document references.
