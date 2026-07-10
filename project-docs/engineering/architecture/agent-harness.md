# Agent Harness

Ayati uses a single decision-action-reducer harness. The old multi-stage
controller stack is removed, and executable tools are exposed directly through
native provider tool calling.

Current loop:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Primary code paths:

- `ayati-main/src/ivec/agent-loop.ts`: thin entry wrapper that resolves loop config and calls the runner.
- `ayati-main/src/ivec/agent-runner/runner.ts`: loop orchestration, run persistence, local completion, feedback recording, and failure history.
- `ayati-main/src/ivec/agent-runner/state-view.ts`: structured state view sent to the decision model, including compact working feedback.
- `ayati-main/src/ivec/agent-runner/context-pack.ts`: bounded decision context pack.
- `ayati-main/src/ivec/agent-runner/tool-catalog.ts`: hidden tool index, groups, aliases, and deterministic follow-up metadata.
- `ayati-main/src/ivec/agent-runner/tool-working-set.ts`: run-scoped visible tool schema cap, loading, and deactivation.
- `ayati-main/src/ivec/agent-runner/decision.ts`: model-facing native tool surface and decision prompt.
- `ayati-main/src/ivec/agent-runner/repair-policy.ts`: stable repair-code catalog and formatting helpers for model-facing repair prompts and operator feedback.
- `ayati-main/src/ivec/agent-runner/action-executor.ts`: validates and executes internal action records.
- `ayati-main/src/ivec/verification-contracts/progress-reducer.ts`: reduces verified facts into current-run `workState`.

## Design Principle

Executable tool inputs must be generated under the executable tool's own native
schema. Do not hide executable calls inside a generic wrapper with an untyped
`input` object.

This means the model does not call a generic `decision_act` tool. It either
answers directly with assistant text for terminal replies, calls a small
control tool, or calls one selected executable tool directly.

## Native Tool Surface

Each decision call exposes two classes of native provider tools:

```text
control tools:
  decision_load_tools({ query?, toolNames?, groups? })
  ask_user_feedback({ question, reason }) only during an active task run

selected executable tools:
  write_files({ files, createDirs? })
  patch_files({ files: [{ path, patches: [{ kind: "replace_lines", startLine, endLine: "EOF" }] }] })
  read_files({ files: [{ path, ... }] })
  shell({ cmd, ... })
  ...
```

The selected executable tool list is bounded by the current working set. For
example, when `write_files` is selected, the provider receives the real
`write_files.inputSchema`, including its required `files` field. The provider
can then enforce the actual executable schema instead of only enforcing a
generic action wrapper.

The harness adds a required `taskCompletion` metadata object to each selected
executable schema before exposing it to the provider. The metadata tells the
runner whether the model believes this exact tool call is a completion
candidate if deterministic verification passes. The metadata is removed before
the local tool executes.

The provider call allows direct assistant text for normal terminal replies and
disables parallel provider tool calls where supported. When a native tool call
is needed, the model must call exactly one tool. A model response can be:

- direct assistant text: terminal user-facing answer.
- `decision_load_tools`: request missing tools for a later decision.
- `ask_user_feedback`: pause an active task run for required user feedback
  when progress is genuinely blocked and no safe default exists.
- a selected executable tool: concrete work to run through the action executor.

Unknown native tools, multiple native tool calls, missing executable tools,
task feedback outside an active task run, and invalid tool inputs are rejected
deterministically and repaired when possible.

Every provider-handled chat turn and provider-handled system event starts as a
session run. A session run is an immutable/read-first run record owned by the
session-store until mutation becomes necessary. Read-only tools may execute in
this state without creating or binding a task. Mutation tools cannot execute
from an unbound session run; the runner must first promote the active session
run into a task run.

When git-memory has an `unbound` or `clarifying` pending turn, mutation tools
are blocked. The model may use read-only tools, git-context read/search tools,
and the turn-aware routing tools:

- `git_context_activate_task_for_turn`
- `git_context_create_task_for_turn`
- `git_context_ask_clarification_for_turn`

When a fresh session has no active task, read-only tools remain available on the
session run. Mutating work still requires a promotion target or clarification
first: the initial routing surface exposes
`git_context_set_promotion_target_for_turn`,
`git_context_create_task_for_turn`, and
`git_context_ask_clarification_for_turn`. The target tool is preferred for new
durable work because it records intent without creating a durable task; the task
is created only if a later mutation tool promotes the active session run. If the
model tries to call a mutation tool before a task or target exists, the runner
records repair feedback instead of throwing a missing-run error to the user.

Routing mutation tools are treated as routing controls, not ordinary work
tools. During routing modes they are pinned outside the normal selected-tool and
visible-tool budgets, so repair can always ask the model to create, activate,
or clarify a task with a callable native tool. Once ownership is resolved or a
real work run exists, those mutation tools are removed from the run surface.

When an active task exists, the turn still starts as a session run. The model
may inspect with read-only tools first. If the request belongs to the same
active task and a mutation tool is selected, the runner asks the app runtime to
promote the active session run into that task run immediately before the first
mutation executes. If the request is new, different, or ambiguous, the model may
use routing tools during the window. Unused routing tools expire after the
routing window, and any promoted mutation removes routing tools from the
surface.

After a routing tool succeeds, the runner refreshes the harness context into
the returned real task run id, removes routing/search/create/switch tools for
the rest of that run, and prepares normal work tools for the original user
message. This allows flows such as:

```text
fresh request -> git_context_set_promotion_target_for_turn -> write_files -> final reply
read-only question -> read_files -> final reply stored as session run
same active task -> read_files -> write_files -> final reply stored as task run
different existing task -> git_context_activate_task_for_turn -> normal work tool -> final reply
ambiguous task -> git_context_ask_clarification_for_turn -> clarification reply stored as session run
clarification answer -> git_context_activate_task_for_turn -> write_files -> final reply stored as task run
```

Clarification is not a deferred promotion. Once the assistant asks the
clarifying question and the session run finalizes, that run is sealed. The
user's answer starts a fresh session run and can be promoted only if that answer
turn activates, targets, or creates a task before mutation.

Promotion can happen only while the session run is active. After a session run
is finalized in the session-store, it is sealed and must not be converted into a
task run later. Final storage is exclusive: an unpromoted run is finalized under
`session-store`; a promoted run is finalized under the task directory using the
same run id. The runtime must never write a finalized run to both locations.

The model should not call a tool just to continue the already-active task;
obvious same-task continuation is automatic. The model must not directly commit
runs, update task state, or use low-level branch switch/create tools during
normal live turns.

## Internal Decision Shape

The decision layer normalizes native tool calls into the existing internal
`AgentDecision` union:

```text
direct text         -> { kind: "reply", ... }
decision_load_tools -> { kind: "load_tools", ... }
ask_user_feedback   -> { kind: "ask_user", ... }
write_files(...)    -> { kind: "act", action: single call to write_files }
read_files(...)      -> { kind: "act", action: single call to read_files }
```

The action executor still receives `AgentAction` records. This preserves the
existing execution, verification, artifact, memory, and progress-reducer code
while removing the model-facing nested action wrapper.

`decision_load_tools` must include at least one non-empty selector:

- `groups`: exact group names from the compact loading map, such as
  `file:read`, `file:write`, or `shell:command`
- `toolNames`: exact tool names when already known
- `query`: search text when the model is unsure which hidden tool should load

`reason` is intentionally not part of `decision_load_tools`. The loader does
not infer selectors from explanation text.

## Decision Prompt Layout

The decision prompt is split to preserve provider prompt-cache reuse:

```text
system:
  stable decision-component role
  stable harness and native tool-use rules
  stable control tool shapes
  truncated runtime system context, when present

user:
  selected executable tool definitions for this decision
  compact hidden tool loading map with loadable groups and representative tool names
  State view JSON
```

Stable decision rules live in the system message so repeated decisions share a
cache-friendly prefix. Dynamic state remains in the user message. Do not move
work-run ids, tool observations, current input, personal memory snapshots, git
context, or working feedback ahead of the stable decision
contract.

Critical decision rules and control tool shapes must not be placed inside the
truncatable runtime system-context block. If runtime system context is too
large, only that runtime block may be truncated.

## Context Budget Measurement

Every decision request is measured after the system messages, dynamic state,
repair history, and native tool schemas have been assembled. Measurement uses
the fast local estimator for normal requests and asks the provider to count the
same final request when corrected local usage reaches the configured soft limit
and provider counting is available.

The default 128K profile has three explicit policy thresholds:

```text
recovery target: 60K
soft input limit: 70K
hard input limit: 100K
```

Ayati supports context profiles of 128K tokens and larger. The default profile
also reserves 8K for output. Larger profiles derive the same proportions unless
the runtime LLM configuration provides explicit thresholds. Below the soft
limit, this layer does not transform context.

Tool-context projection has a runtime policy with two modes:

- `shadow` is the default. Ayati measures the complete candidate and records
  the deterministic alternative, but sends the unchanged candidate.
- `enforce` applies the deterministic tool projection after the candidate
  reaches the soft limit, rebuilds the complete request, and measures that
  final request before provider generation.

The request admitted to the provider is rejected before generation when it
exceeds the hard input limit. In enforcement mode the unmodified candidate may
exceed that limit because it is an internal compilation input, not a provider
request. Exact provider counts may use the full hard limit. Local or inexact
counts use a conservative admission limit at 95% of the hard limit.

Budget reports record the model/profile source, local and provider counts,
input capacity, all three thresholds, admission result, pressure ratio and
overflow status. A context-compilation receipt records candidate and final
tokens, mode, transformations, target recovery, and final admission. Candidate
and final reports are separate so a successful projection cannot hide that the
original request crossed a limit. The run-scoped pressure state counts at most
one soft breach per runner iteration, so repair attempts do not artificially
advance future pressure modes. Reports are emitted once per distinct decision
or repair attempt, not once per transport retry.

A deterministic pressure controller evaluates only the first decision attempt
of each runner iteration. A tool-compacted request at or below the recovery
target resets the unresolved-pressure streak, even if the full candidate keeps
crossing the soft limit on later iterations. A compacted final request that
remains above the target advances the streak. Two unresolved iterations
recommend a timeline checkpoint; a final request at 90% or more of its
admission limit recommends it immediately. Applied mode and recommended next
mode are separate so the runtime never reports an unavailable compaction stage
as already performed. Enforced pressure also counts as unresolved when there
are no eligible older tool calls to compact; shadow-only observations never
advance escalation policy.

Timeline checkpoint planning is deterministic before any summarizer is called.
It selects only an older contiguous prefix needed for estimated recovery,
keeps at least four recent events exact, protects the current input and latest
assistant question awaiting interpretation, and hashes the selected source for
cache identity. The checkpoint contract retains sequence references for
requests, constraints, decisions, corrections, facts, unresolved questions,
and external references.

When timeline checkpointing is recommended and tool projection still leaves the
request above the recovery target, the compiler asks the active provider for a
strict structured summary of only the selected timeline prefix. It sends no
tools, task state, work state, tool history, personal memory, or unrelated
session context. Runtime code supplies the trusted coverage range and source
hash, validates every referenced sequence, and enforces the planned checkpoint
token budget. Providers may enforce JSON Schema, downgrade to JSON-object mode,
or rely on prompt-only JSON; local parsing and semantic validation always run.

Generation allows one repair. Successes and failures are cached for the run by
prompt version, provider/model, source hash, checkpoint budget, and generator
input capacity. A failed source is not retried on every decision. If generation
fails, the source timeline remains exact and the tool-only request is used when
admissible; otherwise admission rejects it before the decision call. Successful
compilation measures candidate, tool-projected intermediate, and checkpointed
final requests separately.

Current-run tool-call storage and prompt projection are separate. Below the
soft limit, all prompt-eligible tool calls are sent in full; there is no fixed
six-call or 30K-character history cap. At the soft limit, a deterministic
shadow planner protects the latest six calls, failures, and calls without a
recovery reference, then proposes previews or summaries for only as many older
calls as needed to reach the recovery target. Reference-only conversion is
reserved for a later repeated-pressure mode. Plans are recorded in optimization
metrics and the feedback ledger. With `enforce`, the same plan is applied to a
new prompt projection; the source tool-call records, durable task context, and
run work state remain unchanged.

Shadow planning uses registered deterministic projectors for filesystem reads,
filesystem search/listing, filesystem mutations, shell calls, test/build
commands, and Git-context operations, with a conservative generic fallback.
Projector metadata is captured
while the structured tool result is available, bounded to exclude duplicate
file contents, and never included in the normal full prompt. The planner builds
the complete alternative decision request through the normal prompt serializer
and measures it with the same corrected local estimator as the real request.
Receipts record the projector id and per-call estimates plus whole-request
projected tokens and savings. After an enforced projection, the next state view
receives a compact pressure signal with the active mode, number of compacted
calls, and whether the recovery target was reached. This tells the agent to
work in smaller, recoverable steps without replacing the stable decision
contract. The signal may include a recommended later mode and deterministic
escalation reason. It is runtime-owned; the decision model must not rewrite or
summarize protected context on its own.

## Tool Visibility

The runtime keeps a hidden catalog of available tools and exposes a run-scoped
working set of at most `maxSelectedTools` executable schemas, currently 15 by
default. The source of truth for tool grouping and lifecycle metadata is the
static tool taxonomy, not scattered prompt text.

The hidden catalog prompt summary is compact by design. It lists smaller
purpose-built loadable groups and representative tool names so the model can
request 1-3 groups together, or exact names when obvious, without injecting
every full tool schema into every decision.

Tool groups should stay small and purpose-built. Examples include:

- `file:inspect`: path metadata before reading or editing.
- `file:find`: directory and content discovery.
- `file:read`: file reads, batched reads, and content search.
- `file:write`: file creation and edits.
- `shell:command`: explicit command execution only.
- `git-context:*`: task/session context retrieval and routing.

Before each decision, the runner deterministically prepares likely tools from
the current input, attachments, git task context, work state, evidence refs, and
recent failures. If the model needs a missing capability, it calls
`decision_load_tools` with exact tool names, groups, or a search query. Tool
execution can also deterministically load likely next tools, for example
`find_files` loading `read_files` and `patch_files`. Some tools deactivate
automatically after success or after one step.

Tool loading is deterministic at the boundary. A request to create or build a
website, app, file, or project should prepare file create/write/read tools, not
shell by default. Shell tools should load for explicit run/test/install/start or
command-execution intent. This keeps the model from using a shell transcript as
the primary way to create simple files.

Tool lifecycle is also part of the taxonomy. Read and write tools should remain
available across the active run when they are useful for ongoing work.
Narrow routing, discovery, or repair-only tools may expire after success, after
one decision, or when their mode no longer applies. Runtime policy can remove
unsafe or irrelevant tools without relying on the model to unload them.

Tool loading has explicit outcomes:

- `loaded`: new tools were mounted for the current run
- `already_active`: requested tools were already visible
- `partial`: some selectors matched and some did not
- `no_match`: selectors were valid but matched no tools
- `invalid_request`: no non-empty selector was provided
- `failed`: an internal load failure occurred
- `not_needed`: deterministic follow-up loading had nothing to add

The latest load outcome is stored in transient run state and appears in the next
decision prompt under `context.tools.lastLoad`.
It includes requested selectors, loaded tools, already-active tools, evictions,
missing selectors, status, and a short message. Historical load outcomes are
not accumulated in prompt context.

If a load request fails or matches the wrong thing, repair should show the model
the available loading vocabulary: valid groups, representative tools, matched
selectors, missing selectors, and a short recovery message. The repair should
help the model make a better `decision_load_tools` call instead of forcing a new
classification step.

Tool-mode feedback is operator-facing and compact. The runner records
`tools.tool_mode_selected`, `tools.pre_task_routing_tools_visible`,
`tools.normal_tools_enabled_for_work_run`, and
`tools.routing_tools_deactivated` so live logs explain why routing tools or
normal tools were visible.

The working set is cleared at task finalization. Legacy JSON decision parsing is
kept for tests and migration resilience, but the app runtime should use native
control tools plus selected native executable tools.

## State View And Working Feedback

The decision model receives a compact `State view` each iteration. Runtime code
may keep compatibility aliases internally, but the model prompt is projected to
a deduplicated grouped payload:

- `context.timeline`: every exact conversation record after the latest valid
  task-run checkpoint, ending with the exact current input. Before the first
  task-run checkpoint it contains the complete session conversation. The agent
  context pack does not apply another event-count or per-message character cap.
- `context.git.session`: session metadata, optional compressed session summary,
  the latest five task-run checkpoints, up to ten recent session attachment
  metadata records, and recent session activity.
- `context.git.current`: focus, pending-turn routing state, and selected task
  context when a task is resolved.
- `context.tools`: active tool names and the latest tool-load result.
- `context.run`: current-run status and the ordered tool-call memory for
  this run.
- `context.harness`: harness repair feedback for the current decision.
- `context.personal`: long-lived user memory snapshot when present.

The internal aliases `context.gitContext`, top-level `progress`,
`workingFeedback`, `toolLoad`, `observations`, `trace`, `attachments`, and
`systemEvent` may still exist for compatibility inside the runtime state view.
They should not be treated as canonical model-facing paths. Trace and
system-event metadata should not be placed under `context.run`.

Working feedback is model-facing. Feedback ledger events are operator-facing.
Both should describe the same harness reality:

- what native tools were visible
- which tool the model selected
- whether the input satisfied the executable schema
- what failed and how the model should recover

Repair feedback uses stable `R_*` repair codes instead of one-off prompt
strings. The same repair signal can be projected three ways:

- a compact model-facing repair prompt in `context.harness.feedback`
- operator-facing feedback event data under `repair.code`
- feedback-ledger warning and triage summaries

Current repair codes cover implemented deterministic repairs only:

- `R_ASSISTANT_TEXT_TOOL_CALL`
- `R_TOOL_NOT_SELECTED`
- `R_LOAD_TOOLS_USED_AS_ACTION`
- `R_EMPTY_TOOL_LOAD_SELECTOR`
- `R_TOOL_INPUT_INVALID`
- `R_TOOL_INPUT_MISSING_REQUIRED_FIELD`
- `R_FRESH_SESSION_NEEDS_TASK`
- `R_NORMAL_TOOL_WITHOUT_TASK_RUN`
- `R_PENDING_TURN_UNBOUND`
- `R_PENDING_TURN_CLARIFYING`
- `R_TASK_FEEDBACK_UNAVAILABLE`
- `R_MULTIPLE_NATIVE_TOOL_CALLS`
- `R_PARSE_FAILED`
- `R_PROVIDER_EMPTY_RESPONSE`
- `R_VERIFICATION_FAILED`
- `R_NO_PROGRESS`
- `R_REPEATED_REPAIR_FAILURE`

Do not add future repair codes to the catalog until a harness guard, decision
validator, feedback projection, and focused tests use them.

The decision model does not receive the internal run path, generated goal
contract, empty progress scaffolding, or old activity/task-thread shelves. Open
task continuation stays inside the existing decision stage through
`context.git.current.task`: it gives the model enough structured state to
continue the focused work branch, use task assets, start new work, or ask the
user when runtime task resolution is ambiguous.

If tool output is truncated, chunked, or evidence-only, the model should use
normal domain tools with narrower input instead of repeating broad reads or
commands.
Prompt-facing ordered tool output for the current run is carried by
`context.run.toolCalls`, including tool input, compact output,
errors, artifacts, and evidence refs. Read-heavy tool results use the same
channel. Raw read output remains in run evidence and tool records; task state
should retain only useful facts, summaries, files, evidence refs, and run
metadata.

The model should prefer `inspect_paths` before large or unfamiliar reads. A
direct `read_files` or `read_files` call is still allowed, but filesystem read
tools can return advisory feedback when metadata would have been safer first,
for example when paths are broad, output is truncated, or the file shape is
unknown. This advisory is a repair hint, not a hard block.

## Feedback Triage

The feedback ledger writes compact operator-facing summaries under
`feedback/latest-summary.json` and `feedback/triage-summary.json` when feedback
tracing is enabled. The latest summary preserves the raw run signals:

- final status and response kind
- iteration, tool-load, action-step, and tool-call counts
- verification and verified-fact flags
- compact git-context routing and finalization state, including pending-turn
  status, route source, route mode, task id, branch/ref, run id, commit, and
  committed/skipped/failed finalization status
- warning signals such as protocol repair, failed actions, repeated tool loads,
  or completed work without tool calls

When feedback event data contains `repair.code`, the ledger indexes that stable
code as a warning signal. Triage then reports the repair class directly, for
example provider empty responses, missing task routing before normal tools,
verification failures, no-progress decisions, or repeated identical repair
loops.

The triage summary converts those signals into a small review outcome:

- `healthy`: no warning or error findings were recorded for the latest run
- `needs_review`: the run completed but produced warning-level signals
- `failed`: the run ended with a non-completed status, runtime error, or failed
  action signal

This triage file is not model-facing context. It exists to make benchmark and
live-feedback data actionable for developers by turning raw trace facts into
concrete improvement categories.

## Action Execution

The model-facing executable step is one native executable tool call. Internally,
Ayati adapts that call into a single-call `AgentAction` so existing executor and
verification behavior remains stable.

The action executor rejects invalid internal action records before any tool
runs. It validates:

- selected-tool membership and allowed tool membership
- non-empty unique call ids
- mode-specific call counts
- dependencies, including earlier-call-only dependencies for sequential mode
- exact planned-call coverage after execution
- deny-by-default parallel safety for legacy or local recovery actions
- tool input through the selected tool's actual schema

Parallel execution is intentionally narrow and should remain a local executor
concern. Model-facing provider calls should remain one native tool call per
decision. The harness can continue the loop for follow-up calls after observing
the result.

Tool execution records:

- tool name
- input
- output/error
- structured result
- operation status
- artifacts
- verified facts
- assertion results

## Verification

The default verification path is deterministic:

1. Tool input is validated against the executable tool schema.
2. Tool executes.
3. Tool result contracts and assertions run through the tool executor.
4. The action executor applies execution gates before reducing progress:
   all-failed executions and empty action output fail with validation skipped.
5. Required contract assertion failures fail the step.
6. Known deterministic tool outputs can pass through deterministic success gates
   when their output shape proves the requested operation succeeded.
7. Evidence, artifacts, and verified facts are extracted.
8. Progress reducer updates `workState`.

Use semantic or LLM verification only for work that cannot be proven with tool
contracts, assertions, file checks, process exits, database state, or artifacts.

Successful tool transport alone is not proof of completed work. Tools without
deterministic gates or contract-backed verification can execute successfully,
but their validation status remains skipped unless another verifier proves the
result. This keeps `workState` grounded in machine-checkable evidence.

## Feedback Ledger

Feedback events are written for debugging and operator inspection. The decision
stage records:

- `prompt_summary`: selected tools, visible tool count, working feedback count,
  work status, and compact input state.
- `native_tool_surface`: control tools, selected executable tools, required
  fields, and total native tool count.
- `raw_response`: native tool call summary and raw normalized response.
- `parsed`: normalized `AgentDecision`.
- protocol or input-schema violations and repair requests.

The action stage records starts, completions, individual tool results,
artifacts, and failures. Final feedback records the summary used by
`latest-summary.json`.

The runner also records read-progress signals for active task runs. These
signals help detect loops where the model keeps selecting read-only tools after
enough context is available for a requested write or edit. The guard should
prefer a useful next action: write/edit when the requested work is concrete, ask
a specific clarification question when required information is missing, or stop
with a blocked state when progress cannot be made.

Context-engine feedback events are operator-facing observability, not
model-facing control. They record compact lifecycle facts such as
`context_engine.prepared`, `context_engine.routed`,
`context_engine.agent_routed`, `context_engine.clarification_requested`,
`context_engine.finalization_skipped`, `context_engine.finalization_failed`,
and `context_engine.committed`. Developer agents should use those events to
follow the owning task branch, run id, commit, and evidence pointers when
debugging Ayati behavior.

## Completion

The runner can mark work complete when:

- `workState.status` is already `done`, or
- a deterministic local action succeeded and no user input is needed.

Completion does not mean the deterministic verifier writes a tool transcript to
the user. Verified local work sets `workState.status` to `done`, keeps evidence
and contract details internal, and produces a user-facing completion reply from
verified state. The final reply should answer naturally using user-visible
results such as paths, changed files, command findings, or next steps, without
mentioning harness internals.

## Failure Handling

Failures are stored in `failureHistory` and compacted into
`context.harness.feedback`.
The local failure policy can retry deterministic recoveries, such as retrying
file writes with `createDirs=true` when a parent directory is missing.

Repeated identical validation failures should stop with a clear reason instead
of running endless repair loops.

Repeated repair stopping is based on the repair signature: repair code plus
blocked targets and missing or invalid fields. After the same signature repeats
too many times, the runner records `R_REPEATED_REPAIR_FAILURE` and fails cleanly
instead of asking the model to retry the same broken move again.

Future work should use `strategyReviewFailureThreshold` for a targeted
strategy-review model call only after repeated unclassified failures.

## Do Not Reintroduce

Do not re-add these removed concepts:

- model-facing `decision_act` for executable work
- generic nested executable input objects
- separate `understand`, `direct`, or `reeval` stages
- controller prompt files
- context scout controller path
- read-run-state controller directives
- inline skill activation directives
- V1/V2 harness switches
