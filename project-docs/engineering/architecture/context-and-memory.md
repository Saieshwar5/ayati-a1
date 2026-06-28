# Context And Memory

Ayati should feel continuous without asking the user to manage context windows.
Task/work continuity now comes from the git context engine, not the old
session task-thread or Activity continuation path.

Current runtime model:

```text
daily git context + run recorder + personal memory -> context pack -> decision state view
```

## Git Context

The durable work context is a daily git repository managed by the context
engine under `ayati-main/src/context-engine/`.

The runtime flow is:

```text
user message
-> context engine records conversation on main
-> task resolver creates/selects a work branch
-> agent loop receives compact git context
-> completed run writes state, actions, output, assets, and commit metadata
```

The model-facing state uses `State view.context.gitContext`. It contains:

- `session.conversationTail`: bounded user/assistant/system conversation from
  the daily session.
- `session.eventTail`: bounded session events such as task creation, focus
  changes, and run commits.
- `focus`: the current git focus ref.
- `task`: selected work branch context when a task is resolved.

`gitContext.task` includes:

- work id, title, objective, status, and branch ref
- completed work, open work, blockers, facts, and next step
- `assets`: task assets from `tasks/<workId>/assets.jsonl`
- recent run summaries and compact commit summaries

Ambiguous task resolution is handled before the agent loop runs. The app asks
the user to choose rather than asking the model to guess from multiple possible
tasks.

## Conversation

Conversation is recorded in the daily git session on the main branch:

```text
session/conversation.jsonl
```

The context pack reads only a bounded tail for the model. Task-specific
conversation can be recovered later by filtering the main conversation and git
events/commits that resolved to a work id or branch.

## Task Branch Files

Each work branch owns task files under:

```text
tasks/<workId>/
```

Core files:

- `task.json`: stable identity and metadata.
- `state.json`: current machine-readable task state.
- `assets.jsonl`: user, agent, document, directory, generated, and reference
  assets that belong to the task.
- `summaries/<runId>.json`: one summary per completed run.
- `actions/<runId>/<actionId>.json`: compact tool/action metadata.
- `actions/<runId>/<actionId>-output.*`: bounded action output evidence.
- `outputs/final.json`: latest final answer/output for the task.

Run commits carry useful Ayati commit trailers such as session id, work id,
run id, event, status, and action ids. The commit message is part of the
machine-readable retrieval surface.

## Assets

The agent loop returns `taskAssets` separately from old task summaries. The
context engine persists them to the task branch.

Current asset shape:

```ts
interface TaskAssetRecord {
  assetId: string;
  role: "input" | "output" | "generated" | "reference";
  kind: string;
  name: string;
  sessionAssetId?: string;
  path?: string;
}
```

Attachment restore uses `context.taskAssets` from tool execution context. It
does not use Activity memory. Document and dataset assets are re-prepared from
their path through `DocumentStore`; file and directory assets return path-based
restore output for follow-up file tools.

## Personal Memory

Personal memory remains separate from task/work continuity.

Keep:

- personal memory store
- personal memory snapshot cache
- memory consolidation/evolution
- episodic memory if it is used as semantic recall
- system event outcome storage if Pulse depends on it

Personal memory enters the model only as optional `personalMemorySnapshot`.

## Run Recorder

The live run recording contract is narrow and explicit through `RunRecorder`.
Agent action execution depends on `RunRecorder`, so tool logging and progress
logging do not need access to any session-memory service.

`RunRecorder` handles:

- tool calls and results
- agent progress steps
- run failures

`SessionMemory` and the old `MemoryManager` runtime have been removed from the
app path. Chat and system-event turns use git context for message recording,
run identity, task routing, assistant response recording, and task-run commits.
Agent action execution receives only the narrow `RunRecorder` contract, with
git-memory run ids supplied before tool execution.

## Removed Current Path

The model-facing context must not include:

- `continuity`
- `taskThreadContext`
- `sessionWork`
- Activity search/select/update/archive tools
- `activity_restore_assets`
- task summary publication into Activity/task-thread memory

Those concepts may appear in historical docs, tests for removed behavior, or
migration notes, but they are not the current runtime direction.
