# Agent Harness

Ayati now uses a single decision-action-reducer harness. The old multi-stage
controller stack is removed.

Current loop:

```text
context pack -> deterministic tool preload -> decision -> action executor -> deterministic follow-up tool loading -> deterministic verification -> progress reducer
```

Primary code paths:

- `ayati-main/src/ivec/agent-loop.ts`: thin entry wrapper that resolves loop config and calls the runner.
- `ayati-main/src/ivec/agent-runner/runner.ts`: loop orchestration, run persistence, local completion, and failure history.
- `ayati-main/src/ivec/agent-runner/state-view.ts`: structured state view sent to the decision model.
- `ayati-main/src/ivec/agent-runner/context-pack.ts`: bounded decision context pack.
- `ayati-main/src/ivec/agent-runner/tool-catalog.ts`: hidden tool index, groups, aliases, and deterministic follow-up metadata.
- `ayati-main/src/ivec/agent-runner/tool-working-set.ts`: run-scoped visible tool schema cap, preload, loading, and deactivation.
- `ayati-main/src/ivec/agent-runner/decision.ts`: model-facing decision schema and prompt.
- `ayati-main/src/ivec/agent-runner/action-executor.ts`: validates and executes tool actions.
- `ayati-main/src/ivec/verification-contracts/progress-reducer.ts`: reduces verified facts into the current run `workState`.

## Decision Shape

The decision model must call exactly one native decision tool. These are
meta-tools, not executable runtime tools:

```text
decision_reply({ status, message })
decision_ask_user({ question, reason })
decision_load_tools({ query?, toolNames?, groups? })
decision_act({ mode, allowedTools, calls, assertions? })
```

The native decision tool call is converted into the internal `AgentDecision`
union:

```text
decision_reply      -> { kind: "reply", ... }
decision_ask_user   -> { kind: "ask_user", ... }
decision_load_tools -> { kind: "load_tools", ... }
decision_act        -> { kind: "act", ... }
```

`decision_load_tools` must include at least one non-empty selector:

- `groups`: exact group names from the compact loading map, such as
  `skill:filesystem` or `workflow:code_edit`
- `toolNames`: exact tool names when already known
- `query`: search text when the model is unsure which hidden tool should load

`reason` is intentionally not part of `decision_load_tools`. The loader does
not infer selectors from explanation text.

Executable tools such as `read_file`, `shell`, `list_directory`, or `pulse` are
not exposed as native provider tools during the decision call. If execution is
needed, the model calls `decision_act` with an action plan. Ayati then validates
and executes that plan locally through the action executor.

There is no separate required model call to create a goal. The first decision
uses the current input and context pack directly. `workState` starts minimal and
only appears in the model-facing state view after real progress, blockers,
verified facts, evidence, or user-input needs exist.

## Decision Prompt Layout

The decision prompt is split to preserve provider prompt-cache reuse:

```text
system:
  stable decision-component role
  stable harness and tool-use rules
  stable response JSON shapes
  truncated runtime system context, when present

user:
  selected executable tool definitions for this decision
  compact hidden tool loading map with loadable groups and representative tool names
  State view JSON
```

Stable decision rules live in the system message so repeated decisions share a
cache-friendly prefix. Dynamic state remains in the user message. Do not move
work-run ids, tool observations, current input, memory snapshots, learning
context, or continuity context ahead of the stable decision contract.

Critical decision rules and response shapes must not be placed inside the
truncatable runtime system-context block. If runtime system context is too
large, only that runtime block may be truncated.

## Tool Visibility

Normal action tools are no longer always visible as kernel tools. The runtime
keeps a hidden catalog of available tools and exposes a run-scoped working set
of at most `maxSelectedTools` schemas, currently 12 by default.

The hidden catalog prompt summary is compact by design. It lists loadable groups
and representative tool names per skill so the model can request tools by group
first and exact name when obvious, without injecting every full tool schema into
every decision.

Before each decision, the runner deterministically preloads likely tools from
the current input, attachments, continuity, work state, evidence refs, and
recent failures. If the model needs a missing capability, it returns
`load_tools` with exact tool names, groups, or a search query. Tool execution can
also deterministically load likely next tools, for example `find_files` loading
`read_file` and `edit_file`. Some tools deactivate automatically after success
or after one step.

Tool loading has explicit outcomes:

- `loaded`: new tools were mounted for the current run
- `already_active`: requested tools were already visible
- `partial`: some selectors matched and some did not
- `no_match`: selectors were valid but matched no tools
- `invalid_request`: no non-empty selector was provided
- `failed`: an internal load failure occurred
- `not_needed`: deterministic follow-up loading had nothing to add

The latest load outcome is stored in transient run state and appears in the next
decision state view as `toolLoad`. It includes the requested selectors, loaded
tools, already-active tools, evictions, missing selectors, status, and a short
message. This lets the model recover from bad selectors instead of assuming a
no-op load succeeded. Historical load outcomes are not accumulated in prompt
context.

The provider call receives only the four native decision tools. Ayati requires
exactly one decision tool call and disables parallel provider tool calls where
the provider supports that control. If the provider returns text, zero decision
tool calls, multiple decision tool calls, or an unknown tool call, the decision
is rejected and the runner performs one native decision repair attempt before
failing deterministically.

The working set is cleared at task finalization. Legacy direct tool-definition
callers are still supported, but the app runtime should use the hidden catalog
and working-set manager.

## State View And Context

The decision model receives a compact `State view` each iteration. The context
portion is built by `context-pack.ts` and currently includes:

- `timeline`: chronological bounded user/assistant/system events ending with
  the current input
- `continuity`
- `sessionWork`: compact same-session activity summaries
- optional `personalMemorySnapshot`

`recentTasks` is no longer a model-facing field. Tool-using task outcomes are
converted into activity threads after the run. Future runs resolve those
threads deterministically into `continuity.mode` of `new`, `continue`, or
`ambiguous`.

The rest of the state view is sparse. Empty sections are omitted. When present,
it can include:

- `progress`: current-run status, summary, open work, blockers, verified facts,
  evidence, next step, or user input needed.
- `toolLoad`: the most recent tool-loading outcome, only when a load was tried
  or deterministic follow-up loading had a result.
- `observations`: recent real tool-output context cards.
- `trace`: compact recent execution steps and deterministic failures.
- `attachments`: incoming/prepared/managed attachments only when present.
- `systemEvent`: the current system event only for system-event runs.

The decision model does not receive the internal run path, generated goal
contract, or empty progress scaffolding.

## Action Execution

Actions are explicit tool-call plans. Supported modes are:

- `single`: exactly one tool call.
- `sequential`: ordered calls, up to four per step, with dependency skipping
  when a prior call fails.
- `parallel`: concurrent calls, up to three per step, only for independent
  read-only tools that pass deterministic parallel-safety checks.

There is no `autonomous` action mode. The model may choose whether to reply,
ask, load tools, or act, but every `act` decision must contain a concrete
single, sequential, or parallel call plan.

The action executor rejects invalid plans before any tool runs. It validates:

- selected-tool membership and `allowedTools`
- non-empty unique call ids
- mode-specific call counts
- dependencies, including earlier-call-only dependencies for sequential mode
- exact planned-call coverage after execution
- deny-by-default parallel safety

Parallel execution is intentionally narrow. A parallel call is accepted only
when every tool is annotated, allowlisted, read-only, retry-safe,
non-destructive, non-long-running, and does not mutate workspace or external
state. The initial allowlist is:

- `calculator`
- `read_file`
- `list_directory`
- `search_in_files`
- evidence read tools: `evidence_next_chunk`, `evidence_read_lines`,
  `evidence_tail`, and `evidence_search`

Shell, Python, UI/workspace tools, Pulse, skill activation, database mutation,
memory/activity mutation, and all filesystem create/write/edit/move/delete
tools are sequential-only unless a future design adds a stronger deterministic
parallel contract for them. Missing annotations mean sequential-only.

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

1. Tool input is validated.
2. Tool executes.
3. Tool result contracts and assertions run through the tool executor.
4. The action executor applies execution gates before reducing progress:
   all-failed executions and empty action output fail with validation skipped.
5. Required contract assertion failures fail the step.
6. Known deterministic tool outputs can pass through deterministic success gates
   when their output shape proves the requested operation succeeded.
7. Evidence, artifacts, and verified facts are extracted.
8. Progress reducer updates `workState`.

Use semantic/LLM verification only for work that cannot be proven with tool
contracts, assertions, file checks, process exits, database state, or artifacts.

Successful tool transport alone is not proof of completed work. Tools without
deterministic gates or contract-backed verification can execute successfully,
but their validation status remains skipped unless another verifier proves the
result. This keeps `workState` grounded in machine-checkable evidence.

## Completion

The runner can mark work complete when:

- `workState.status` is already `done`, or
- a deterministic local action succeeded and no user input is needed.

Completion does not mean the deterministic verifier writes the user-facing
answer. Verified local work sets `workState.status` to `done`, keeps evidence
and contract details internal, and then routes through a final decision-model
reply. The final reply should answer the user naturally using user-visible
results such as paths, changed files, command findings, or next steps, without
mentioning harness internals.

## Failure Handling

Failures are stored in `failureHistory`. The local failure policy can retry
deterministic recoveries, such as retrying file writes with `createDirs=true`
when a parent directory is missing.

Future work should use `strategyReviewFailureThreshold` for a targeted
strategy-review model call only after repeated unclassified failures.

## Do Not Reintroduce

Do not re-add these removed concepts:

- separate `understand`, `direct`, or `reeval` stages
- controller prompt files
- context scout controller path
- read-run-state controller directives
- inline skill activation directives
- V1/V2 harness switches
