# Agent Harness

Ayati now uses a single decision-action-reducer harness. The old multi-stage
controller stack is removed.

Current loop:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Primary code paths:

- `ayati-main/src/ivec/agent-loop.ts`: thin entry wrapper that resolves loop config and calls the runner.
- `ayati-main/src/ivec/agent-runner/runner.ts`: loop orchestration, run persistence, local completion, and failure history.
- `ayati-main/src/ivec/agent-runner/state-view.ts`: structured state view sent to the decision model.
- `ayati-main/src/ivec/agent-runner/context-pack.ts`: bounded decision context pack.
- `ayati-main/src/ivec/agent-runner/decision.ts`: model-facing decision schema and prompt.
- `ayati-main/src/ivec/agent-runner/action-executor.ts`: validates and executes tool actions.
- `ayati-main/src/ivec/verification-contracts/progress-reducer.ts`: reduces verified facts into the current run `workState`.

## Decision Shape

The decision model returns exactly one of:

```json
{ "kind": "reply", "status": "completed", "message": "..." }
{ "kind": "ask_user", "question": "...", "reason": "..." }
{ "kind": "act", "action": { "mode": "single", "calls": [], "allowedTools": [], "assertions": [] } }
```

There is no separate required model call to create a goal. The first decision
uses the current input and context pack directly. `workState` starts minimal and
only appears in the model-facing state view after real progress, blockers,
verified facts, evidence, or user-input needs exist.

## State View And Context

The decision model receives a compact `State view` each iteration. The context
portion is built by `context-pack.ts` and currently includes:

- `currentInput`
- `recentConversation`
- `activeFocus`
- `sessionFocusCards`
- `attentionShelf`
- optional `personalMemorySnapshot`
- optional `activeLearningContext`

`recentTasks` is no longer a model-facing field. Tool-using task outcomes are
converted into session focus cards after the run, and reusable cards can later
be searched, activated, updated, and promoted into the attention shelf.

The rest of the state view is sparse. Empty sections are omitted. When present,
it can include:

- `workState`: current-run status, summary, open work, blockers, verified facts,
  evidence, next step, or user input needed.
- `lastActions`: the last one or two tool actions, not full step history.
- `recentFailures`: recent deterministic failures only when failures exist.
- `attachments`: incoming/prepared/managed attachments only when present.
- `systemEvent`: the current system event only for system-event runs.

The decision model does not receive the internal run path, generated goal
contract, or empty progress scaffolding.

## Action Execution

Actions are explicit tool-call plans. Supported modes are:

- `single`: exactly one tool call.
- `sequential`: ordered calls, with dependency skipping when a prior call fails.
- `parallel`: concurrent calls, with filesystem overlap safety checks.
- `autonomous`: schema placeholder only; currently rejected until a concrete action model is implemented.

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
