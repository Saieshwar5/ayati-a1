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
  read_file({ path, ... })
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

When git-memory has an `unbound` or `clarifying` pending turn, normal task tools
are blocked. The model may use git-context read/search tools and the
turn-aware routing tools:

- `git_context_activate_task_for_turn`
- `git_context_create_task_for_turn`
- `git_context_ask_clarification_for_turn`

When a fresh session has no active task, the initial routing surface is smaller:
only `git_context_create_task_for_turn` and
`git_context_ask_clarification_for_turn` are exposed. There is no task to
search, read, or activate yet. If the model tries to load or call normal work
tools before a task exists, the runner records repair feedback instead of
throwing a missing-run error to the user.

After a routing tool succeeds, the runner refreshes the harness context into
the returned real task run id, removes routing/search/create/switch tools for
the rest of that run, and prepares normal work tools for the original user
message. This allows flows such as:

```text
fresh request -> git_context_create_task_for_turn -> write_files -> final reply
existing task -> git_context_activate_task_for_turn -> normal work tool -> final reply
```

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
read_file(...)      -> { kind: "act", action: single call to read_file }
```

The action executor still receives `AgentAction` records. This preserves the
existing execution, verification, artifact, memory, and progress-reducer code
while removing the model-facing nested action wrapper.

`decision_load_tools` must include at least one non-empty selector:

- `groups`: exact group names from the compact loading map, such as
  `skill:filesystem` or `workflow:code_edit`
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

## Tool Visibility

The runtime keeps a hidden catalog of available tools and exposes a run-scoped
working set of at most `maxSelectedTools` executable schemas, currently 12 by
default.

The hidden catalog prompt summary is compact by design. It lists loadable groups
and representative tool names per skill so the model can request tools by group
first and exact name when obvious, without injecting every full tool schema into
every decision.

Before each decision, the runner deterministically prepares likely tools from
the current input, attachments, git task context, work state, evidence refs, and
recent failures. If the model needs a missing capability, it calls
`decision_load_tools` with exact tool names, groups, or a search query. Tool
execution can also deterministically load likely next tools, for example
`find_files` loading `read_file` and `edit_file`. Some tools deactivate
automatically after success or after one step.

Tool loading has explicit outcomes:

- `loaded`: new tools were mounted for the current run
- `already_active`: requested tools were already visible
- `partial`: some selectors matched and some did not
- `no_match`: selectors were valid but matched no tools
- `invalid_request`: no non-empty selector was provided
- `failed`: an internal load failure occurred
- `not_needed`: deterministic follow-up loading had nothing to add

The latest load outcome is stored in transient run state and appears in the next
decision prompt under `context.tools.lastLoad` and `context.scratch.toolLoad`.
It includes requested selectors, loaded tools, already-active tools, evictions,
missing selectors, status, and a short message. Historical load outcomes are
not accumulated in prompt context.

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

- `context.timeline`: chronological bounded user/assistant/system events ending
  with the current input.
- `context.git.session`: session metadata, optional compressed session summary,
  session attachments, and recent session activity.
- `context.git.current`: focus, pending-turn routing state, and selected task
  context when a task is resolved.
- `context.tools`: active tool names and the latest tool-load result.
- `context.scratch`: current-run progress, working feedback, tool observations,
  trace, transient attachments, and system-event state.
- `context.personal`: long-lived user memory snapshot when present.

The internal aliases `context.gitContext`, top-level `progress`,
`workingFeedback`, `toolLoad`, `observations`, `trace`, `attachments`, and
`systemEvent` may still exist for compatibility inside the runtime state view.
They should not be treated as the canonical model-facing paths.

Working feedback is model-facing. Feedback ledger events are operator-facing.
Both should describe the same harness reality:

- what native tools were visible
- which tool the model selected
- whether the input satisfied the executable schema
- what failed and how the model should recover

The decision model does not receive the internal run path, generated goal
contract, empty progress scaffolding, or old activity/task-thread shelves. Open
task continuation stays inside the existing decision stage through
`context.git.current.task`: it gives the model enough structured state to
continue the focused work branch, use task assets, start new work, or ask the
user when runtime task resolution is ambiguous.

If observations point to truncated, chunked, or `evidence_only` output, the
model should use evidence tools before rerunning the original output-producing
tool. Evidence rereads are hot context under `context.scratch.observations` and
should not become durable task memory unless verified progress promotes a fact.

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
`context.scratch.feedback`.
The local failure policy can retry deterministic recoveries, such as retrying
file writes with `createDirs=true` when a parent directory is missing.

Repeated identical validation failures should stop with a clear reason instead
of running endless repair loops.

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
