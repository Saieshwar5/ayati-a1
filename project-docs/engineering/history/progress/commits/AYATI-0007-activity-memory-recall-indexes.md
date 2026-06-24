# AYATI-0007 Activity Memory Recall Indexes

## Context

Activity threads are Ayati's durable work memory. The previous implementation
already stored thread state, identities, aliases, assets, runs, and events, but
search depended on compact text matching and exact anchors. That made recall
strong for file or document continuation and weaker for topic, goal, blocker,
or question-shaped follow-ups.

## Changes

- Added first-class activity recall cues generated from goals, actions,
  blockers, facts, next steps, assets, entity hints, and likely future
  questions.
- Added activity entities for structured retrieval by topic, tool, file,
  directory, document, dataset, URL, and activity kind.
- Replaced the old compact `activity_search` text table with
  `activity_search_fts`, a SQLite FTS5 index over title, summary, activity
  state, cues, entities, aliases, and assets.
- Updated activity search to combine exact cue, exact entity, exact alias, FTS5,
  token-overlap, and recency/open-work scoring.
- Updated continuity scoring so cues and entities are deterministic resolver
  signals alongside identities, aliases, text, and recency.
- Made activity writes atomic with one SQLite transaction covering thread state,
  identities, aliases, cues, entities, assets, runs, FTS refresh, and event
  insertion.
- Added an activity-store schema upgrade path that adds missing activity run
  discussion-range columns to older development databases, removes the retired
  compact search table, and backfills missing FTS rows.
- Exposed cues and entities through `activity_get`.
- Removed legacy compatibility code for the old activity search table and
  activity-run column migration.

## Current Contract

The activity retrieval path is:

```text
exact identity -> exact cue/entity/alias -> FTS5 -> deterministic scoring
-> continue | ambiguous | new
```

Activity remains the central work-memory object. Artifacts, procedures, and
project-like knowledge should first be represented as activity assets, cues,
entities, events, decisions, or links before introducing a separate memory
store.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test -- tests/memory/activity-store.test.ts
```

Both commands passed. The package test command currently runs the full backend
Vitest suite through the package script and reported 90 test files passed and
551 tests passed.
