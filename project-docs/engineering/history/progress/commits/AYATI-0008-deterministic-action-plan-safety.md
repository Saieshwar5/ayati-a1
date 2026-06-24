# AYATI-0008 Deterministic Action Plan Safety

## Context

The agent harness let the decision model choose between acting, asking,
loading tools, and replying, but the action contract still had two weak spots:

- `maxCalls` could silently truncate planned calls before execution.
- `parallel` relied mostly on model judgment plus filesystem overlap checks.

That made it possible for the agent to claim a task was complete after only a
prefix of the intended tool plan ran, and it left unsafe concurrent tools such
as shell, Python, UI, memory, database mutation, or file writes too close to
parallel execution.

## Changes

- Removed the `autonomous` action mode. Every action is now a concrete
  `single`, `sequential`, or `parallel` plan.
- Removed model-provided `maxCalls`; the executor no longer slices planned
  calls before execution.
- Added separate configured limits for sequential and parallel action modes.
- Added deterministic action-plan validation for call ids, selected tools,
  `allowedTools`, dependencies, and mode-specific call counts.
- Added exact planned-call coverage verification so every planned call must be
  recorded as executed, failed, or skipped.
- Made sequential execution stop after the first failure and explicitly record
  later skipped calls.
- Made tool execution failures return failed call records instead of escaping
  past verification.
- Made local completion require a real write/edit/delete-style tool success,
  so directory creation alone cannot complete generated-file tasks.
- Made parallel execution deny-by-default. Parallel calls are allowed only for
  annotated, allowlisted, read-only, retry-safe, non-destructive,
  non-long-running tools that do not mutate workspace or external state.
- Updated decision rules and harness docs to match the executor-owned safety
  contract.

## Current Contract

The supported action modes are:

```text
single     -> exactly one selected tool call
sequential -> up to four ordered calls, dependencies must point backward
parallel   -> up to three independent calls, deny-by-default safety policy
```

Parallel is initially limited to deterministic read-only tools:

- `calculator`
- `read_file`
- `list_directory`
- `search_in_files`
- `evidence_next_chunk`
- `evidence_read_lines`
- `evidence_tail`
- `evidence_search`

All other tools are sequential-only unless their metadata and the executor
allowlist are deliberately updated.

## Verification

```text
pnpm --filter ayati-main exec vitest run tests/ivec/action-executor.test.ts
pnpm --filter ayati-main exec vitest run tests/ivec/action-executor.test.ts tests/ivec/decision.test.ts
pnpm --filter ayati-main exec vitest run tests/ivec
pnpm --filter ayati-main build
```

All commands passed. `pnpm --filter ayati-main test` was also run; it still has
unrelated development-environment failures in server port binding tests, pulse
scheduler schema handling, and one Python stdout assertion.
