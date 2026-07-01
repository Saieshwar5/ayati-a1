# Context And Memory

Ayati should feel continuous without asking the user to manage context windows.
Task/work continuity now comes from the git context engine, not the old
session task-thread or Activity continuation path.

Current runtime model:

```text
daily git context + run recorder + personal memory -> git context pack -> decision state view
```

## Git Context

The durable work context is a daily git repository managed by the context
engine under `ayati-main/src/context-engine/`.

The runtime flow is:

```text
user message
-> context engine records the global conversation on main
-> runtime auto-binds obvious same-task continuation, or the agent uses
   git-context read/search and turn-aware routing tools when ownership is
   semantic or ambiguous
-> agent loop receives compact git context
-> completed run writes task state, run summaries, evidence, and commit metadata
```

Pending-turn routing states are:

- `unbound`: user message is global only; task ownership is not decided.
- `bound`: runtime has selected/created a task, appended the conversation range
  to that task branch, and allocated a run id.
- `clarifying`: ownership is ambiguous; no task branch receives the turn and no
  run id is allocated until the user answers.

While a pending turn is `unbound` or `clarifying`, normal task tools are blocked.
The agent may use git-context read/search tools and turn-aware routing tools:
`git_context_activate_task_for_turn`, `git_context_create_task_for_turn`, and
`git_context_ask_clarification_for_turn`.

The model-facing prompt uses a grouped context projection. The important paths
are:

- `context.timeline`: exact recent conversation and the current input.
- `context.git.session`: session identity, optional compressed session summary,
  user-provided session attachments, and recent session activity.
- `context.git.current`: current git focus, pending turn state, and selected
  task context when a task is resolved.
- `context.tools`: active tool names and the latest tool-load result.
- `context.scratch`: current-run progress, working feedback, tool
  observations, trace, transient attachments, and system-event state.
- `context.personal`: long-lived personal memory snapshot when present.

The internal compatibility field `context.gitContext` can still exist inside
runtime state for older code paths, but it is not promoted as a separate model
prompt section. New model-facing guidance should use the grouped paths above.

`context.git.current.task` includes:

- task identity: work id, title, objective, branch/ref, and task id when known
- state: status, completed work, open work, blockers, facts, summary, and next
  step
- task assets
- recent run summaries and evidence summaries

The default harness context is intentionally compact. It should include the
current input and exact recent conversation in `context.timeline`, compressed
session history in `context.git.session.summary` when available, pending turn
state, active task identity/state, recent active-task runs, recent evidence
summaries, assets, and pending/degraded git writes.

It should not include every task branch, every old conversation, full git logs,
full run/action histories, raw evidence, or old session data. Those are
retrieved on demand through structured git-context read/search tools such as
`git_context_search_tasks`, `git_context_read_task`, `git_context_log`,
`git_context_read_evidence`, and `git_context_search_evidence`.

Turn-aware routing tools may update the active harness context, but their
model-facing result should not expose the runtime's full internal memory cache.
They return route identifiers plus refreshed harness context; task lists and
deep history remain explicit retrieval operations.

Ambiguous task ownership can be marked through the turn-aware clarification
path. The runtime does not allocate a run id or append the pending turn to a
task branch until ownership is clear.

Do not expose low-level `git_context_create_task`,
`git_context_switch_task`, `git_context_commit_run`, or
`git_context_update_task_state` as normal model-facing tools. The agent may
express routing intent; runtime owns branch mutation, run allocation, state
reduction, and commits.

## Session Summary

Session summaries live in the session-store submodule:

```text
session-store/sessions/<sessionId>/summary.md
session-store/sessions/<sessionId>/summary.json
```

The summary is exposed to the model at `context.git.session.summary`. It is a
compressed aid for session continuity, not a complete source of truth. When the
summary conflicts with exact conversation, the model should trust
`context.timeline`.

The default summary updater is deterministic. It writes structured Markdown
sections such as current focus, recent decisions, open questions, and recent
messages. The summary metadata records the update strategy, covered sequence
range, source sequence range, message count, and previous covered sequence when
known.

LLM session summaries are available only by explicit runtime configuration.
When enabled, the LLM updater uses the main provider and falls back to the
deterministic updater on provider errors, invalid output, tool-call responses,
or empty summaries.

## Hot Tool Context

Tool output shown to the model is hot, bounded context, not durable task
memory. The agent should see enough raw context to make the next decision, but
large files, command logs, and evidence slices should not remain in every prompt
for the whole run.

The runtime exposes recent tool cards in
`State view.context.scratch.observations.latest`.
Each card has deterministic retention metadata:

- `next_step`: temporary output for the next decision, such as command output
  or a saved-evidence reread.
- `while_relevant`: compact file/search/list context that can guide nearby
  work.
- `evidence_only`: a preview of very large output; use evidence tools before
  relying on the preview.

Raw output is still available through run-scoped evidence refs and evidence
tools (`evidence_search`, `evidence_read_lines`, `evidence_tail`, and
`evidence_next_chunk`). Evidence rereads can help the next decision, but they
should not become durable task notes by default. Durable task facts should come
from verification and progress reduction, not from keeping arbitrary raw slices
in long-lived context.

## Conversation

Conversation is canonical as Markdown:

```text
main:session/conversation.md
task/W-...:session/conversation.md
```

The `main` branch stores the global daily conversation. Task branches store the
conversation blocks that belong to that task. Normal task conversation is
append-only synced to both:

```text
active task branch:session/conversation.md
main:session/conversation.md
```

Ayati does not use a normal full branch merge for this sync. Only the
conversation block is copied to `main`, so task-local state, run files, action
traces, and intermediate files remain on the task branch.

Conversation blocks may include task, run, and branch metadata:

```md
## 2026-06-28T09:00:05+05:30 Assistant

Task: W-20260628-0001
Run: R-20260628-0001
Branch: task/W-20260628-0001-fix-upload-handling

I inspected the upload path.
```

`session/conversation.jsonl` remains only as a compact debug log. It is not the
canonical model context. New rows are intentionally small:

```json
{"seq":1,"role":"user","at":"2026-06-28T09:00:00+05:30","text":"Fix upload handling","branch":"main"}
```

Message ids, turn ids, schema row versions, task-message link ids, and event
ids should not be treated as conversation identity. Runtime APIs may still use
turn ids in memory to correlate a prepared user turn with an assistant response.

## Focus And Events

The active task custom ref is the preferred focus source, with the current git
branch as a fallback.

```text
main = no active task
task/W-... = active task branch
```

`session/focus.json` is not canonical state. Git commit history and Ayati
commit trailers are the durable event log. Context readers derive session event
tails from commits such as task creation and run completion.

Debug/event JSONL files may exist in historical sessions or tests, but current
model-facing context should not depend on them.

## Task Branch Files

Each work branch owns task files under:

```text
tasks/<taskId>/
```

Core files:

- `task.md`: human/model-readable task identity and objective.
- `task.json`: stable machine-readable identity and metadata.
- `state.json`: current machine-readable task state.
- `runs/<runId>.md`: human/model-readable run summary.
- `runs/<runId>.json`: machine-readable run summary.
- `actions/<runId>.jsonl`: compact tool/action metadata for a run.
- `evidence/<runId>/manifest.jsonl`: durable compact evidence records.
- `assets.json` or equivalent asset index when task assets are present.

Run commits carry useful Ayati commit trailers such as session id, task id, run
id, event, status, branch, conversation sequence, and action ids. The commit
message and run Markdown should include compact human-readable summary,
outcome, work performed, verification, blockers, evidence, and next step. Raw
tool output stays in evidence files/manifests, not in commit messages or task
state.

## Assets

Attachments and task assets are separate from conversation text but should be
represented in git context when they belong to task continuity.

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

Future attachment work should make assets visible in both:

- conversation Markdown when the user attaches files
- task asset state for exact ids, paths, checksums, and restore metadata

## Personal Memory

Personal memory remains separate from task/work continuity.

Keep:

- personal memory store
- personal memory snapshot cache
- memory consolidation/evolution
- episodic memory if it is used as semantic recall
- system event outcome storage if Pulse depends on it

Personal memory enters the model prompt under `context.personal.memorySnapshot`.
The older top-level `personalMemorySnapshot` alias may still exist in internal
compatibility state, but new prompt-facing work should use `context.personal`.

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
