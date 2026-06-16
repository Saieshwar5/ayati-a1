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

When a new daily session starts, the hot cache starts fresh for that session.
The old session's recent exchanges are not carried into `recentConversation`; they
remain in the old JSONL file and may later influence the compact
`personalMemorySnapshot` through background memory evolution.

## Context Pack

The decision model receives dynamic decision context through
`State view.context`, built by:

- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`

The context pack is bounded JSON. Session-derived model-facing fields are:

- `recentConversation`: last 5 completed user/assistant exchanges
- `activeFocus`: focus cards explicitly activated for the current session
- `sessionFocusCards`: up to 5 current-session focus cards ranked by recency
  and usefulness
- `attentionShelf`: up to 5 global focus cards promoted from prior sessions

Outside `State view.context`, the prompt state is intentionally sparse. The
first decision normally receives no `workState` at all. `workState`,
`lastActions`, `recentFailures`, `attachments`, and `systemEvent` are included
only when they carry useful data. This keeps early decisions fast and prevents
empty or synthetic state from steering the model.

Session metadata such as session id, path, age, turn count, and handoff state
stays internal to the backend for persistence, debugging, rotation policy, and
memory consolidation. It is not exposed to the decision model.

Recent system activity is also kept internal by default. Direct system-event
runs expose the current event through `State view.systemEvent`, but prior system
events are not included in every decision context.

Other context sources remain independent from session:

- `personalMemorySnapshot`
- `activeLearningContext`
- task/run details in `data/runs/<runId>/`
- document/file stores
- long-term or semantic memory stores

## Focus Cards

Focus cards are the durable continuation surface for tool-using work. They are
stored outside session JSONL in `data/memory/memory.sqlite`.

Tables:

- `focus_items`: current focus card state.
- `focus_events`: append-only focus-card event history.
- `focus_search`: compact local search text for card lookup.

Scopes:

- `session`: cards created from tool-using task summaries in the active
  session.
- `global`: cross-session attention shelf cards.

Lifecycle:

1. The runner completes a task run and builds a task summary from `workState`,
   open work, blockers, verified facts, evidence, tools used, and artifacts.
2. `IVecEngine` publishes the summary through `queueTaskSummaryPublication`.
3. `MemoryManager.queueTaskSummary` creates a session focus card only when the
   summary has at least one tool in `toolsUsed`.
4. No-tool direct replies are intentionally skipped.
5. Focus tools can search, get, activate, deactivate, update, and list focus
   cards.
6. Activated cards are returned as `activeFocus` for the current session.
7. When a session closes, durable session focus cards are promoted or merged
   into global cards for the attention shelf.

The decision model sees compact shelf items, not full focus rows. Full card
details can be retrieved through focus tools when needed.

Boundary:

- Current-run progress belongs in run state and run artifacts.
- Reusable continuation state belongs in focus cards.
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
5. The runner syncs hot recent activity and focus-card shelves into
   `LoopState`.
6. `context-pack.ts` includes bounded recent conversation and focus context in
   the decision prompt.
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
