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
- `ayati-main/src/ivec/agent-runner/context-pack.ts`: bounded runtime context pack.
- `ayati-main/src/ivec/agent-runner/decision.ts`: model-facing decision schema and prompt.
- `ayati-main/src/ivec/agent-runner/action-executor.ts`: validates and executes tool actions.
- `ayati-main/src/ivec/verification-contracts/progress-reducer.ts`: reduces verified facts into task progress.

## Decision Shape

The decision model returns exactly one of:

```json
{ "kind": "reply", "status": "completed", "message": "..." }
{ "kind": "ask_user", "question": "...", "reason": "..." }
{ "kind": "act", "action": { "mode": "single", "calls": [], "allowedTools": [], "assertions": [] } }
```

There is no separate required model call to create a goal. The runner creates a
simple local goal from the current input, and the decision model uses the state
view/context pack to decide the next outcome.

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
3. Tool result contracts and assertions run.
4. Action-level assertions run when supplied.
5. Evidence and verified facts are extracted.
6. Progress reducer updates task state.

Use semantic/LLM verification only for work that cannot be proven with tool
contracts, assertions, file checks, process exits, database state, or artifacts.

## Completion

The runner can complete locally when:

- task progress is already `done`, or
- a deterministic local action succeeded and no user input is needed.

This avoids extra model calls for simple file/tool tasks.

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
