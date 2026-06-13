# AYATI-0002 Personal Memory Evolution

## Context

Personal memory needed to become more reliable than a search-first bag of
cards. The system should update current user personalization after sessions,
avoid duplicate memories, preserve evidence, and handle large sessions without
blocking the active chat path.

## Changes

- Added address-first personal memory lookup:
  exact address, learned alias, same slot, FTS, then recent section fallback.
- Added `memory_aliases` so equivalent slots can resolve to one canonical
  memory, for example `preference/explanation_depth` pointing to
  `preference/answer_depth`.
- Added `memory_events` as an append-only evolution timeline for creates,
  confirms, contradictions, supersedes, merges, archives, and rejects.
- Updated `memory_explain` to include evolution events along with evidence and
  score information.
- Wired automatic personal memory evolution to session rotation. When the local
  daily session changes, Ayati opens the new session immediately, closes the old
  session in the background, replays the old JSONL transcript, and enqueues the
  full ordered user/assistant transcript for consolidation.
- Added chunked extraction for large closed sessions. The consolidator extracts
  candidates from bounded turn chunks, merges duplicate or corrected candidates,
  then resolves the final candidate set once.
- Documented that the new session's hot recent activity starts fresh; old
  recent exchanges remain in the closed session file and may later appear only
  as compact personal memory if consolidation accepts them.

## Current Contract

Automatic personal memory evolution happens after session close, not after every
message. It must not block active chat or new session creation.

Small closed sessions are processed directly. Large closed sessions are split
into chunks. Chunk extraction only proposes candidate memories; real memory
state changes happen after merge through the resolver.

Personal memory is not raw chat history. The prompt receives only the projected
`personalMemorySnapshot`; the database keeps the state, evidence, aliases, and
evolution events.

## Verification

```text
pnpm --filter ayati-main test -- tests/memory/daily-session-manager.test.ts tests/memory/personal-memory.test.ts
pnpm --filter ayati-main build
```

Both commands passed. The focused test command currently runs the package test
suite and reported 94 test files passed, 575 tests passed, and 12 skipped.

## Follow-Ups

- Consider an explicit manual "close current session" command if users want
  memory evolution before the next daily rotation.
- Consider adding provider token counting to choose chunk sizes by tokens
  instead of only by configured turn count.
