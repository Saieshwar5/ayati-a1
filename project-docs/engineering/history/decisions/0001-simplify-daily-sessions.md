# Simplify Daily Sessions

## Context

The old session layer mixed recent conversation, task summaries, tool events,
active attachments, focus updates, handoff summaries, and context-pressure
rotation. That made session management harder to reason about and made the
agent context path too broad.

The redesigned agent architecture needs session to provide fast recent
activity, not act as the complete memory system.

## Decision

Session is now a daily activity log for one client. A new session is created
when the local date changes. Each session has a unique `sessionId` and is saved
under:

```text
data/memory/sessions/YYYY-MM-DD/<sessionId>.jsonl
```

Session files store only:

- `session_open`
- `user_message`
- `assistant_response`
- `system_event`

Each entry keeps `runId` when it belongs to a run. The active session maintains
hot memory for:

- last 5 user/assistant exchanges
- last 5 system events

On startup, today's active session file is replayed to rebuild the hot cache.

## Alternatives Considered

Keeping task summaries and focus cards in session was rejected because those
are work-memory concepts, not daily activity. Keeping context-pressure rotation
was rejected because session boundaries are now intentionally day-based.

## Consequences

The agent loop gets fast recent activity through `State view.context`.
Long-term facts, task state, files, tool evidence, and work continuity must live
outside session in run artifacts or independent memory stores.

Old session files are not migrated into the new schema.
