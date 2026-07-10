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
-> chat runtime serializes same-session turns
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
- `clarifying`: ownership is ambiguous; no task branch receives the turn until
  the user answers.

Only one chat turn per client/session should enter pending-turn preparation and
routing at a time. This serialization belongs above the context engine because
the race is not just a git write conflict; it is two agent loops acting as if
they both own the current pending turn.

Every provider-handled chat turn and system event starts as a session run in
the session-store. While a pending turn is `unbound` or `clarifying`, mutation
tools are blocked, but read-only tools may execute in that session run. The
agent may also use git-context read/search tools and turn-aware routing tools:
`git_context_activate_task_for_turn`, `git_context_create_task_for_turn`, and
`git_context_ask_clarification_for_turn`.

Fresh sessions are read-capable but mutation-gated. If there is no active task,
read-only tools can run in the session run, while mutation requires a promotion
target, task activation, task creation, or clarification first. Prefer
`git_context_set_promotion_target_for_turn` for new durable work: it records a
non-durable target and does not create a task unless a later mutation tool
promotes the active session run. Routing/target tools do not consume the normal
selected-tool budget while routing is active; otherwise normal tools can crowd
out the very tools needed to choose a target or bind a task. After
activation/creation returns a ready route, or after a target is promoted by the
first mutation, the runner refreshes `context.git.current`, removes routing
tools for the rest of the run, and then allows normal mutation tools.

If an active task exists, the turn still starts as a session run. For same-task
continuation, the model may read first in the session run; the runner promotes
that same run id into the active task immediately before the first mutation
tool executes. For new tasks, different existing tasks, or ambiguous ownership,
the model may use create, activate, or clarify routing tools during the window.
Once mutation promotes the run, or once routing is resolved, routing mutation
tools are removed from the task-run surface.

A session run has exactly one final home. If it remains read-only, it is
finalized in `session-store`. If it is promoted, pre-promotion read steps move
with the same run id into the task step log, and the final run is written only
under the task directory. Completed session runs are sealed and are never
promoted later.

The model-facing prompt uses a grouped context projection. The important paths
are:

- `context.timeline`: exact recent conversation and the current input.
- `context.git.session`: session identity, optional compressed session summary,
  user-provided session attachments, and recent session activity.
- `context.git.current`: current git focus, pending turn state, and selected
  task context when a task is resolved.
- `context.tools`: active tool names and the latest tool-load result.
- `context.run`: current-run status and the ordered tool-call memory for
  this run.
- `context.harness`: harness repair feedback for the current decision.
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
path. The clarification request belongs to the current session run and does not
append the pending turn to any task branch. When the assistant asks the
clarifying question and the turn completes, that session run is finalized under
`session-store` and sealed. The user's answer is a new user turn with a fresh
session run; it must activate, target, or create task ownership again before
mutation. If the answer remains read-only, it finalizes as another session run.
If the answer mutates, only the answer run is promoted to the selected task.

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

Summary files are explicit session-store artifacts. Normal user and assistant
message writes do not automatically generate or commit summaries. Future
summary generation should run as a deliberate context-engine step and write the
same session-store files.

## Hot Tool Context

Tool output shown to the model is hot, bounded context, not durable task
memory. The agent should see enough raw context to make the next decision, but
large files, command logs, and evidence slices should not remain in every prompt
for the whole run.

The runtime keeps complete prompt-eligible current-run records separately from
their model-facing projection. Tool-boundary handling may still chunk or spool
extreme output into durable evidence, but prompt management does not apply an
additional fixed character cap to those run records.

Below the configured soft input limit, every prompt-eligible run tool call is
projected in full at `State view.context.run.toolCalls`. The six-call hot window
does not apply during normal operation. At or above the soft limit, the planner
selects only the older recoverable calls needed to approach the recovery target
while keeping the latest six calls, failures, and calls without recovery
references full. The default `shadow` policy only records this alternative. An
explicit `enforce` policy sends the reserialized and remeasured alternative.

Projection is copy-on-write prompt compilation. It never rewrites the complete
run tool-call records or their evidence, and it does not summarize or compress
`context.git.current.task` or `context.run.workState`. Those protected values
are carried unchanged into the projected request. The active pressure mode is
monotonic within the run and is exposed through a small
`context.run.contextPressure` signal on later decisions. This signal separates
the applied `mode` from `recommendedMode`, tracks unresolved recovery attempts,
and tells the model to use narrower recoverable actions. Repeated full-candidate
soft breaches do not justify more compaction when the projected final request
already reaches the recovery target.

Tool-family projectors use bounded structured result metadata captured during
execution. Read projections preserve requested paths/ranges and file metadata;
search projections preserve query, roots, counts, matches, and continuation
state; shell and test/build projections preserve commands, exit state, and
bounded head/tail diagnostics; verified write projections remove echoed file
contents while preserving paths, hashes, result codes, artifacts, and recovery
refs; Git-context projections preserve task/run/query identifiers and bounded
result metadata. Unknown tools use a conservative generic projector. Internal
projection metadata is stripped from the normal prompt and appears only
through a projected prompt when the enforcement policy applies it.

Each entry contains the tool name, input, status, output or error, artifacts,
evidence refs, and truncation metadata. Internal observation records carry
deterministic retention metadata:

- `next_step`: temporary output for the next decision, such as command output
  or a compact tool result.
- `while_relevant`: compact file/search/list context that can guide nearby
  work.
- `evidence_only`: a preview of very large output; use narrower domain tools
  before relying on omitted output.

Raw output is still saved through run-scoped evidence refs for audit,
debugging, persistence, and git-context summaries. It is not exposed through
run-scoped model-callable evidence tools. If the model needs more context, it
should call the original domain tools with narrower inputs. Durable task facts
should come from verification and progress reduction, not from keeping
arbitrary raw slices in long-lived context.

Read tools use the same prompt-facing projection:
`context.run.toolCalls`. This gives the model the filesystem/search context it
has gathered during the current run without putting raw file contents into task
state. Raw read output stays in run evidence and tool records.

Read context should follow these boundaries:

- show enough recent raw or near-raw context for the next decision
- keep durable raw output in run evidence and tool records
- promote only verified, useful facts into task state
- avoid storing every read forever in scratch or task metadata
- use normal domain tools with narrower inputs to recover missing context when needed

Filesystem metadata should often come before large reads. `inspect_paths`
returns size, line-count, file/directory kind, language/content hints, hashes
when requested, directory counts when requested, and read recommendations. The
model may still read directly, but read tools can emit advisory feedback when
metadata would have reduced truncation, broad reads, or wrong-file decisions.

## Conversation

Conversation is canonical inside the session-store submodule as per-message
Markdown files:

```text
session-store/sessions/<sessionId>/messages/000001-user.md
session-store/sessions/<sessionId>/messages/000002-assistant.md
```

The parent daily-session repository should not store new session conversation
files. For new sessions, parent `main` contains the `session-store` gitlink and
task branches contain task metadata, run summaries, evidence, assets, and
commit records. Conversation messages are written to the session-store working
tree during the live conversation.

Ayati does not commit the session-store on every message. The normal flow is:

1. Initialize the session-store submodule when the daily session is created.
2. Write user/system/assistant messages as session-store working files.
3. When a task run is finalized, append the assistant response if needed.
4. Commit the session-store snapshot.
5. Commit the task run with `sessionStoreCommit` and `conversationRefs`.

Message files may include session, task, and run metadata:

```md
# Message 000002

Role: Assistant
At: 2026-06-28T09:00:05+05:30
Session: S-20260628-local
Task: W-20260628-0001
Run: R-20260628-0001

I inspected the upload path.
```

Task conversation is reconstructed from committed task runs:

```json
{
  "sessionStoreCommit": "abc123...",
  "conversationRefs": [{ "fromSeq": 1, "toSeq": 2 }]
}
```

Readers follow the run's `sessionStoreCommit` into the submodule, load the
message files in the referenced sequence ranges, and render a bounded Markdown
tail for task context. Old `session/conversation.md` and task-local message
files may still be read as legacy fallbacks, but new writes should not create
them.

`session/conversation.jsonl` is not canonical model context. Message ids, turn
ids, schema row versions, task-message link ids, and event ids should not be
treated as conversation identity. Runtime APIs may still use turn ids in memory
to correlate a prepared user turn with an assistant response.

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

- `state.json`: canonical machine-readable task context. It stores task
  identity, objective, status, progress, durable facts, decisions, evidence
  summaries, important files, assets, run ids, recent run summaries, and
  derived search/context hints.
- `runs/<runId>.md`: human/model-readable run summary.
- `runs/<runId>.json`: machine-readable run summary.
- `steps/<runId>.jsonl`: full durable step records for a run, including
  tool calls, full tool inputs and outputs available to the runner,
  observations, deterministic verification, facts, artifacts, and work-state
  updates.
- `assets.json` or equivalent asset index when task assets are present.
- `notes.md`: compact task note/index generated from current task state,
  latest run, recent work, files, facts, and search terms.

Agent task context is built primarily from `state.json`, with recent
`runs/*.json`, compact evidence summaries derived from `steps/*.jsonl`, commit
metadata, and conversation reconstructed from `sessionStoreCommit` plus
`conversationRefs` used as bounded supporting context.
Do not add separate task identity or task-context placeholder files unless a
new reader and persistence contract actually uses them.

Run commits carry useful Ayati commit trailers such as session id, task id, run
id, event, status, branch, conversation sequence, and action ids. The commit
message and run Markdown should include compact human-readable summary,
outcome, work performed, verification, blockers, evidence, and next step. Raw
tool input/output belongs in `steps/<runId>.jsonl`, not in commit messages or
task state.

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
