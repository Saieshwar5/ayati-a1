# Context And Memory

Ayati should feel continuous without asking the user to manage context windows.
Task/work continuity now comes from the git context engine, not the old
session task-thread or Activity continuation path.

Current runtime model:

```text
daily git context + run recorder + personal memory -> git context pack -> decision state view
```

## Git Context

### Two-level active context cache

Ayati keeps two in-memory context layers with one clear authority:

```text
Git + SQLite
-> authoritative Git Context Engine ActiveContext cache
-> revisioned HTTP snapshot
-> disposable harness context mirror
-> model prompt projection
```

The Git Context Engine hydrates its session, pending-conversation, active-run,
and session-summary component caches during startup recovery. Its assembled
`ActiveContext` has a deterministic revision derived from session HEAD and
status, pending-conversation hashes, active run and WorkState revisions, and
task catalog HEADs. Unchanged requests reuse the same assembled object. A
successful durable operation refreshes the affected component cache and
invalidates the assembled snapshot.

Conversation appends are the hot-path exception. The service returns the new
authoritative context revision with the exact persisted message, and the
harness applies that message incrementally to its mirror. The first turn after
startup or a complex dirty transition still loads a complete service snapshot;
later conversation-only turns do not rebuild the full context.

The daemon creates its harness mirror at startup and warms it from the latest
live session when one exists. Normal decisions reuse this agent-ready mirror
without another socket request. Run, task-selection, step, and finalization
boundaries mark the corresponding session dirty immediately. A
dirty mirror is never served: the runtime first drains queued step writes and
then replaces the whole mirror from the authoritative service snapshot.

The harness does not independently reduce durable context. Run-local
WorkState and tool calls still update immediately inside the existing agent
loop, while the context service acknowledgement establishes durability. Both
caches are disposable and rebuild from SQLite and Git after restart.

### Live-test observability

The daemon, process supervisor, HTTP boundary, Git Context Engine, and harness
emit one versioned structured event contract. A request trace id crosses the
Unix-socket HTTP call, while session, run, task, sequence, and step identifiers
link service events back to an agent turn. The contract records lifecycle
facts and bounded metadata; secret-bearing fields and raw file/content fields
are redacted before reaching a sink.

Important proof points include child readiness/restart, cache hit/miss and
revision replacement, task repository validation and direct selection,
session-run promotion, queued and acknowledged step persistence, mutation verification,
verified task-run staging, and the single task-run commit at finalization. When
feedback tracing is enabled,
these events enter the existing feedback JSONL alongside decision, action,
verification, and final-response events. Run `pnpm feedback:git-context` after
a live test to render the latest context timeline and deterministic lifecycle
violations. The reporter also accepts `--input <jsonl>` and optional
`--output <markdown>`.

Feedback pointers are scoped: `latest-session.json` identifies the latest
user/session execution, `latest-run.json` identifies the latest run, and
`latest-process.json` identifies process-only activity. The backwards-compatible
`latest.json` follows the session pointer and cannot be replaced by shutdown
events. Reports correlate transport records through trace identity instead of
mixing unrelated process events into a session.

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

### Commit-based task state

Each V1 task is one normal independent Git repository under the managed task
root and one stable working directory. Creation writes the task card, initial
`R-0001` request, references manifest, ignored inbox, and one identity commit.
There is no clone, bare mirror, session mount, or requested-placement variant
in the normal V1 creation path. After initialization, a mutating task run
advances task history exactly once when the run finishes.

During the run, every mutating tool still receives deterministic authority and
verification. The task HEAD remains fixed until finalization. Finalization
rejects unverified paths, renders compact task/request context, stages only
verified and engine-owned context paths, and creates one commit directly in
the task repository. No push or session gitlink update occurs.

The final commit is the compact task state for future activation. Its tree is
the current deliverable plus `.ayati/task.md`, request files, and references;
its trailers record task/request/run/session identity, outcome, validation,
and optional next action. Full tool inputs, raw external evidence, verification,
and WorkState remain outside task Git.

### Session commit continuity

Agent-facing session history has three deterministic layers:

```text
older committed task runs -> context.git.session.summary
newest five session commits -> context.git.session.recentCommits
current uncommitted messages -> context.timeline
```

The Git Context Engine parses the newest five session commits into structured
conversation, work, asset, outcome, validation, task, and run fields. These
records survive the service and harness caches and are included in normal model
prompts. The prompt does not duplicate the raw commit message. At the session
context-pressure stage, only the newest structured commit is retained; this is
a prompt-only projection and does not change Git or either cache.

Exact current timeline events override recent commits, and recent commits
override the compressed older summary. This boundary lets an informational
follow-up use the latest committed result without activating a task or reading
the task repository again.

### Daily session rollover

Ayati keeps at most one writable Git Context session per agent. A local-date
change requests rollover but never creates a commit merely to close the old
session. If the old session has no running work, no pending conversation, and
a clean session repository, the engine seals it at its existing HEAD and opens
the new daily session. The old repository receives no closing commit.

If conversation or repository state is still uncommitted, the old session
becomes `rollover_pending` and remains writable. User, assistant, and system
event messages continue to belong to that session. Read-only work and later
task selection may continue there, but the engine does not open a second live
session.

The next ordinary task-run finalization commits the complete pending
conversation window through the normal task/session finalization path. Only
after that commit succeeds and the old session is clean does the engine seal
it and open the session for the current local date. Intermediate mutation
checkpoints and read-only session finalization do not complete rollover.

Startup recovery and a lightweight timezone-aware date check reconcile the
same states after downtime. A rollover-pending session may therefore extend
past midnight, or across several dates if no later task run produces a commit;
Ayati creates only the current-date replacement when rollover eventually
completes.

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

For unmistakable social or informational requests, the runtime suppresses
task-routing mutation schemas for that turn and retains direct replies plus
read-only tools. The gate is deliberately conservative: concrete or ambiguous
durable requests keep the normal routing surface.

If an active task exists, the turn still starts as a session run. For same-task
continuation, the model may read first in the session run; the runner promotes
that same run id into the active task immediately before the first mutation
tool executes. For new tasks, different existing tasks, or ambiguous ownership,
the model may use create, activate, or clarify routing tools during the window.
Once mutation promotes the run, or once routing is resolved, routing mutation
tools are removed from the task-run surface.

### Task resource root

An active task run has one trusted filesystem authority: the task's stable
working directory at
`<absolute-workspace-root>/tasks/<task-id>-<slug>`.
The app runtime passes this checkout as a runtime-only `resourceScope` to
executable tools. The model receives the canonical absolute `workingDirectory`
and uses absolute paths rooted inside it for filesystem, search, shell, managed
Python, and other host-resource tool fields. Relative paths, workspace aliases,
and `~` paths are rejected before execution. The task-scoped executor
canonicalizes existing symlinks and the nearest existing parent of new targets,
then rejects paths outside the working directory before requesting Git mutation
authority. A model-provided escape flag is never mutation authority.

V1 has no session task checkout. Historical `W-*` tasks may still have legacy
mount records and gitlinks until they are safely migrated; layout dispatch
keeps those compatibility writes out of V1 repositories.

Portable paths stored inside Git task trees remain task-relative. At the
context boundary Ayati reconstructs old and current portable asset records
against the canonical task `workingDirectory`, so model-facing task assets,
WorkState file artifacts, completion assets, and final file references use one
absolute identity. After absolute-path authorization, the
executor performs a one-way private conversion to a task-relative Git path for
mutation authority and staging. `task_completion` accepts only absolute assets
inside the active task working directory and verifies them by canonical
identity.

Known non-mutating validation commands such as
`node --check /absolute/task/path/file.js` execute with the task checkout as
their absolute `cwd` and do not acquire mutation authority. Other
mutation-capable shell and managed-Python commands must declare bounded
absolute file or directory `targets`; the executor converts only those targets
to private Git paths. Repository-wide `.` authority remains invalid.

A session run has exactly one final home. If it remains read-only, it is
finalized in `session-store`. If it is promoted, pre-promotion read steps move
with the same run id into the task step log, and the final run is written only
under the task directory. Completed session runs are sealed and are never
promoted later.

The model-facing prompt uses a grouped context projection. The important paths
are:

- `context.timeline`: the complete exact conversation after the latest valid
  task-run checkpoint, plus the exact current input. Before the first task-run
  checkpoint it contains the complete session conversation. The agent context
  pack applies no additional fixed event-count or per-message character cap.
- `context.git.session`: session identity, optional compressed session summary,
  the latest five task-run checkpoint summaries, up to ten recent attachment
  metadata records, and recent session activity.
- `context.git.current`: current git focus, pending turn state, and selected
  task context when a task is resolved.
- `context.tools`: active tool names and the latest tool-load result.
- `context.run`: current-run status and the ordered tool-call memory for
  this run.
- `context.harness`: harness repair feedback for the current decision.
- `context.personal`: long-lived personal memory snapshot when present.

Selected executable names may also appear as a compact user-prompt list, while
their callable descriptions and input schemas are supplied only through native
provider tools. Runtime-only output contracts, annotations, taxonomy, and
selection hints are not copied into the prompt.

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
current input and exact open conversation in `context.timeline`, compressed
session history in `context.git.session.summary` when available, the newest
five task-run checkpoints in `context.git.session.recentTaskRuns`, pending turn
state, active task identity/state, recent active-task runs, recent evidence
summaries, assets, and pending/degraded git writes.

It should not include every task branch, every old conversation, full git logs,
full run/action histories, raw evidence, or old session data. Those are
retrieved on demand through structured git-context read/search tools such as
`git_context_search_tasks`, `git_context_read_task`, `git_context_log`,
`git_context_read_evidence`, and `git_context_search_evidence`.

Under timeline-checkpoint enforcement, `context.timeline` may begin with
a structured `kind="checkpoint"` event covering an older sequence range,
followed by exact recent events. Exact events remain authoritative. Checkpoints
are run-scoped prompt artifacts, not durable task facts or session summaries.
They are generated only after unresolved enforced pressure, cached by source
identity, and applied to a copy of the prompt context. The complete source
timeline remains unchanged.

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

Summary files are explicit session-store artifacts. Normal user, assistant, and
session-run writes do not generate or commit summaries. Finalized task runs
prepare a semantic checkpoint from the exact conversation interval since the
previous task-run checkpoint. The app-owned provider may generate a replacement
structured session snapshot; the context runtime validates and stages its
Markdown and metadata in the existing session-store snapshot commit. Provider
or validation failure falls back to a deterministic task-run checkpoint and
does not block task-run completion or overwrite the previous valid summary.

Chat delivery does not wait for semantic task-run finalization. The runtime
first persists the final assistant message, completes the visible response with
`commitStatus="finalizing"`, and runs the existing checkpoint, summary, and Git
commit pipeline behind that response. A later `reply_commit_status` event
reports the committed or failed result. Same-client turns remain serialized and
cannot prepare their next context until the pending finalization barrier has
settled. Normal engine shutdown drains pending finalizations before stopping the
provider.

Task-run checkpoint coverage is recorded in the session-store commit trailers.
This boundary is read back after restart, so the next task-run checkpoint starts
at the following conversation sequence without depending on in-memory state.
Generation runs outside the serialized session write queue. Before persistence,
the finalizer revalidates the prepared interval's source hash.

The session projection reads the newest five valid checkpoint commits in
chronological order. Its open timeline contains every exact conversation record
after the newest valid checkpoint boundary. Invalid checkpoint metadata cannot
advance the boundary; Ayati retains more exact conversation instead of risking
an uncovered gap. Projection metrics separately estimate summary, checkpoint,
open-timeline, and attachment tokens for later pressure policy.

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
references full. The default `enforce` policy sends the reserialized and
remeasured alternative. `shadow` remains available to record the alternative
without applying it.

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

If deterministic tool projection remains at or above the soft limit, prompt
compilation next removes the session summary, older four task-run checkpoint
bodies, and duplicate recent session activity. It retains session metadata,
attachment metadata, the newest task-run checkpoint, the exact timeline,
durable task state, and current run work state. This is an immutable prompt
projection; persisted session data is not changed.

If that projected request still reaches the soft limit, the runtime generates
one structured checkpoint from the newest task-run checkpoint and the minimum
eligible old timeline prefix. The recent exact tail, current input, and the
assistant question answered by that input remain exact. If this final recovery
cannot produce a request below the soft limit, Ayati ends the current run with
`context_limit` and leaves the durable task in progress for a later run.

Once a run has applied a pressure mode, later decisions expose at most ten
selected executable tool schemas. Required routing and Git step-recovery tools
consume slots within that cap. The internal working set remains available for
fast rescoring and rotation, and the hidden loading map becomes a short query
hint instead of repeating the full group catalog.

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

Verified filesystem reads also produce a separate `context.git.current.readContext`
working set. It is a deterministic projection over raw `run_steps`, not a new
source of truth and not part of WorkState. It contains reusable `find_files`,
`inspect_paths`, `list_directory`, `read_files`, and `search_in_files` results
from both session and task runs since the latest successful task-run commit.

The working set follows one commit-window lifecycle:

- a completed read-only session run leaves its verified reads available to
  later turns
- session-to-task promotion preserves the same run ID and read working set
- a newer observation of the same tool/resources replaces the older entry
- a verified mutation invalidates observations for affected paths
- successful task finalization resets the entire active read working set
- raw input, output, verification, and evidence remain durable in run history

The Git Context Engine reconstructs the same working set after restart by
replaying run steps whose run sequence is newer than the latest completed task
finalization. The service ActiveContext cache owns the assembled section; the
harness only mirrors and projects it. When an active-run read is already in the
durable read section, prompt compilation replaces the duplicate full output in
`context.run.toolCalls` with tool, purpose, status, source, and
`readContextKeys` reference metadata.

Run-step persistence is an agent-decision boundary. After deterministic
verification, the harness awaits the context service acknowledgement and a
refreshed authoritative ActiveContext before allowing the next model decision.
The next prompt therefore receives complete reusable content only through
`context.git.current.readContext`; `context.run.toolCalls` keeps the compact
reference. SQLite and run evidence still retain the complete raw step.

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
4. Generate or deterministically build the task-run checkpoint outside the
   session write queue.
5. Stage any valid replacement session summary and commit it with the
   conversation snapshot under a `task_run_checkpointed` commit.
6. Commit the task run with `sessionStoreCommit` and `conversationRefs`.

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
