# Context And Memory

Ayati should feel continuous without asking the user to manage sessions,
threads, or context windows manually.

Current runtime model:

```text
daily session hot memory + runtime context + independent memory stores -> context pack -> decision state view
```

## Session Scope

A session is a simple daily activity log for one client. It is not the general
agent memory store.

Session files are date-partitioned:

```text
data/memory/sessions/YYYY-MM-DD/<sessionId>.jsonl
```

Each session has a unique `sessionId` and stores only:

- `session_open`
- `user_message`
- `assistant_response`
- `system_event`

Each message/event entry keeps `runId`, so deeper debugging can jump from the
daily activity log to the full run artifacts under `data/runs/<runId>/`.

SQLite stores only session lookup metadata in `data/memory/memory.sqlite`:

```text
sessions_meta(
  session_id,
  client_id,
  status,
  session_path,
  opened_at,
  closed_at,
  close_reason,
  last_event_at,
  updated_at
)
```

User messages, assistant responses, and system events are not stored in SQLite;
they live in the daily JSONL session file.

## Hot Session Memory

The active session keeps a small in-memory cache:

- last 5 user/assistant exchanges
- last 5 system events

This cache is the fast path used by the agent loop. On startup, the memory
manager replays today's active session file and rebuilds the cache. Old session
files are not migrated into the new schema.

## Context Pack

The decision model receives dynamic runtime context through
`State view.context`, built by:

- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`

The context pack is bounded JSON. Session-derived fields are:

- `session`: session id/date/path, age, and recent turn count
- `recentActivity`: last 5 user/assistant exchanges
- `recentSystemActivity`: last 5 system events

Other context sources remain independent from session:

- `runtime`: date, time, timezone, weekday
- `personalMemorySnapshot`
- `activeLearningContext`
- task/run details in `data/runs/<runId>/`
- document/file stores
- long-term or semantic memory stores

## Runtime Flow

For each user message:

1. `IVecEngine` asks session memory for today's session.
2. The session manager creates a new daily session if the local date changed.
3. The user message is appended to the session JSONL file.
4. The hot exchange cache is updated.
5. The runner syncs hot recent activity into `LoopState`.
6. `context-pack.ts` includes `recentActivity` in the decision prompt.
7. The assistant response is appended to the session file and completes the hot
   exchange.

For each system event:

1. The event is appended as `system_event`.
2. The hot system-event cache is updated.
3. System events are exposed separately from user/assistant exchanges.

## What Is Not Session

These concepts should not be written into session files:

- task summaries
- tool calls and tool results
- agent step traces
- active attachments
- focus cards
- handoff summaries
- context-pressure rotation state
- personal memory facts

Those belong in run artifacts or independent memory stores. Session answers one
question: what recently happened today?
