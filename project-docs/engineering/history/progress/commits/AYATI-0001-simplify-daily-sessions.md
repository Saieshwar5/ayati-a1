# AYATI-0001 Simplify Daily Sessions

## Context

Session memory had become a mixed persistence layer for conversation history,
task summaries, tool traces, focus updates, attachments, handoff summaries, and
context-pressure rotation. The redesigned agent architecture needs session to be
fast recent activity only.

## Changes

- Replaced rich session events with a small daily session schema:
  `session_open`, `user_message`, `assistant_response`, and `system_event`.
- Date-partitioned session files under `data/memory/sessions/YYYY-MM-DD/`.
- Added hot session memory for the last 5 user/assistant exchanges and last 5
  system events.
- Rebuild hot session memory by replaying today's active session file on
  startup.
- Added `recentActivity` to the agent context pack and kept system events
  separate from conversation exchanges.
- Simplified `sessions_meta` in SQLite to lookup metadata only.
- Removed obsolete session tests for handoffs, focus updates, tool traces, and
  task summaries in session files.
- Added focused tests for daily session creation, hot-cache recovery,
  date-based rotation, simplified session events, episodic extraction, and the
  reduced SQLite schema.

## Current Session Contract

Session answers one question: what recently happened today?

SQLite stores only:

- `session_id`
- `client_id`
- `status`
- `session_path`
- `opened_at`
- `closed_at`
- `close_reason`
- `last_event_at`
- `updated_at`

Actual activity remains in JSONL session files. Long-term memory, task state,
tool evidence, files, and work continuity live outside session.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test tests/memory
```

Both commands passed after the simplification.

The full backend test suite still has unrelated environment/tool failures:
socket bind `EPERM` in server/plugin tests and command stdout expectations in
python/external skill tests.
