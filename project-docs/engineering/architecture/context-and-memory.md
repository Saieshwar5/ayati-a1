# Context And Memory

Ayati should feel continuous without asking the user to manage sessions,
threads, or context windows manually.

Current runtime model:

```text
daily session hot memory + independent memory stores -> context pack -> decision state view
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

Each user, assistant, and system event has a monotonically increasing session
`seq`. User and system events do not carry run ids. Assistant responses may
optionally carry `workRunId` when they came from an execution run, so debugging
can jump from the session log to artifacts under `data/runs/<workRunId>/`.

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

The active session keeps an in-memory replay of today's ordered session events:

- flat user/assistant/system-event timeline with `seq`
- full daily user/assistant exchange log derived from chronological events
- last 5 system events
- `activeContextStartSeq`, derived from the latest saved activity discussion
  range in the session

This cache is the fast path used by the agent loop. On startup, the memory
manager replays today's active session file and rebuilds the cache. Old session
files without `seq` are assigned in-memory sequence numbers during replay.

When a new daily session starts, the hot cache starts fresh for that session.
The old session's events remain in the old JSONL file and may later influence
the compact `personalMemorySnapshot` through background memory evolution.

## Context Pack

The decision model receives dynamic decision context through
`State view.context`, built by:

- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`

The context pack is bounded JSON. Session-derived model-facing fields are:

- `timeline`: chronological bounded event stream ending with the current input.
  Events use simple session `seq` numbers instead of run ids.
- `continuity`: deterministic activity-thread resolution for the current input,
  with `mode: "new" | "continue" | "ambiguous"`
- `sessionWork`: compact same-session activity summaries and the current
  `activeContextStartSeq`

Outside `State view.context`, the prompt state is intentionally sparse. The
first decision normally receives no progress state at all. `progress`,
`observations`, `trace`, `attachments`, and `systemEvent` are included only
when they carry useful data. This keeps early decisions fast and prevents empty
or synthetic state from steering the model.

Session metadata such as session id, path, age, turn count, and handoff state
stays internal to the backend for persistence, debugging, rotation policy, and
memory consolidation. It is not exposed to the decision model.

Recent system activity is also kept internal by default. Direct system-event
runs expose the current event through `State view.systemEvent`, but prior system
events are not included in every decision context.

Other context sources remain independent from session:

- `personalMemorySnapshot`
- `activeLearningContext`
- task/work-run details in `data/runs/<workRunId>/`
- document/file stores
- long-term or semantic memory stores

## Activity Threads

Activity threads are the durable continuation surface for ongoing work. They
are stored outside session JSONL in `data/memory/memory.sqlite` by
`ActivityStore`.

An activity thread is a work thread. Runs are individual execution attempts
inside that thread. The runner resolves the current message against activity
identities before every decision and injects only a compact `continuity` result
into the context pack.

Tables:

- `activity_threads`: current thread state.
- `activity_identities`: exact deterministic anchors such as file paths,
  document ids, file ids, directory ids, prepared input ids, and aliases.
- `activity_aliases`: user/system/inferred names for search and matching.
- `activity_assets`: restorable files, directories, documents, datasets, URLs,
  runs, and other durable references.
- `activity_runs`: compact run history, including trigger and discussion `seq`
  ranges when known.
- `activity_events`: append-only activity event history.
- `activity_search`: compact local search text.

The model-facing continuity shape is:

```ts
type ContinuityContext =
  | { mode: "new"; confidence: number; reasons: string[] }
  | { mode: "continue"; confidence: number; reasons: string[]; current: ActivityContext }
  | { mode: "ambiguous"; confidence: number; reasons: string[]; candidates: ActivityCandidate[] };
```

`ActivityContext` includes:

- `activityId`
- `kind`
- `title`
- optional `goal`
- `openWork`
- optional `nextStep`
- `verifiedFacts`
- `topAssets`
- optional compact `discussionRanges`
- `lastTouchedAt`

Lifecycle:

1. The runner completes a task run and builds a task summary from `workState`,
   open work, blockers, verified facts, evidence, tools used, prepared
   attachments, managed files/directories, and durable artifacts.
2. `IVecEngine` publishes the summary through `queueTaskSummaryPublication`.
3. `MemoryManager.queueTaskSummary` enriches the summary with the trigger
   `seq` and active discussion range.
4. `MemoryManager.queueTaskSummary` creates or updates an activity only when
   the summary has evidence-backed work: tools, activity assets, attachment
   anchors, or explicit continuation `activityId`.
5. No-tool direct replies without durable activity state are intentionally
   skipped.
6. Activity `discussionRanges` point back to the exact session JSONL event
   ranges that led to the work. The raw transcript is not duplicated in SQLite.
7. `ContinuityResolver` deterministically resolves future inputs by exact
   identity anchors first, then aliases/search terms, then recent follow-up
   phrasing.
8. The resolver returns `continue` only for a strong winner with a clear score
   gap. Close matches return `ambiguous`; weak matches return `new`.
9. Activity tools can search, get, select, update, and archive activity threads.

Activity assets:

- User-provided files, directories, documents, and datasets use durable asset
  references that can be restored into later runs.
- Agent-created or modified files are captured as working artifacts when they
  are durable step artifacts.
- `attachment_restore` and `activity_restore_assets` restore assets from the
  current resolved activity or from an explicit `activityId`, `assetId`, or
  reference.

Boundary:

- Current-run progress belongs in run state and run artifacts.
- Reusable continuation state belongs in activity threads.
- Raw conversation remains in session JSONL.
- Personal facts and preferences belong in personal memory.

## Personal Memory

Personal memory is the user personalization store. It is not raw chat history.
The runtime injects only a compact projected snapshot into the prompt, while the
store keeps enough structured state to safely evolve memories over time.

The storage model is:

- `memory_cards`: current best state for a memory card.
- `memory_evidence`: source snippets that justify a card.
- `memory_events`: append-only evolution timeline for create, confirm,
  contradict, supersede, merge, archive, and reject events.
- `memory_aliases`: learned alternate addresses that point to the canonical
  memory address.
- `memory_cards_fts`: local FTS5 fallback index for fuzzy search.

Memory evolution is address-first:

1. Normalize the proposal into `sectionId`, `kind`, and `slot`.
2. Search exact canonical address.
3. Search learned aliases for that address.
4. Fall back to same-slot, FTS, and recent section candidates.
5. Confirm, supersede, reject, or create while appending evidence and an
   evolution event.
6. Regenerate the compact `personalMemorySnapshot`.

This avoids treating vector-like fuzzy search as truth. Fuzzy search can find a
candidate, but only exact address or learned alias matches are strong enough to
drive direct evolution. When fuzzy evidence proves two addresses are equivalent,
Ayati learns an alias so later updates become deterministic.

Automatic personal memory evolution runs after a session closes, not after every
message. When the local session rotates, Ayati opens the new session immediately
and closes the old session in a background task. The close task replays the old
JSONL session file and sends the full ordered user/assistant transcript to the
personal memory consolidator.

Large closed sessions are not sent to the extractor in one prompt. The
consolidator splits them into bounded turn chunks, extracts candidate memories
from each chunk, merges duplicate or corrected candidates, and only then calls
the resolver once for the final candidate set.

The resolver updates personal memory through an append-only evolution model:
current truth is kept in `memory_cards`, while evidence and events preserve why
the card exists and how it changed. This keeps prompt injection compact without
losing the audit trail needed for corrections, dedupe, and explanation.

## Runtime Flow

For each user message:

1. `IVecEngine` asks session memory for today's session.
2. The session manager creates a new daily session if the local date changed.
3. The user message is appended to the session JSONL file.
4. The hot exchange cache is updated.
5. The runner syncs hot recent activity and resolves activity continuity into
   `LoopState`.
6. `context-pack.ts` includes bounded recent conversation and compact
   `continuity` context in the decision prompt.
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
- managed attachment payloads
- activity attachment assets
- activity threads
- handoff summaries
- context-pressure rotation state
- personal memory facts

Those belong in run artifacts or independent memory stores. Session answers one
question: what recently happened today?
