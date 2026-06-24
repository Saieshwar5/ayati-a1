# AYATI-0009 Task Thread Continuation

## Context

Ayati could create durable Activity memory from task summaries, but that was too
heavy for a common case: a run completed successfully while the user's task
remained open. Users often continue the same task in the next message or after a
short detour, and the agent needs compact, high-signal task state without
promoting every partial run to long-term Activity memory.

The harness should stay:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

Open-task continuation should therefore fit into context preparation and the
existing decision stage, not a new controller stage.

## Changes

- Added session-level TaskThread state as the mutable aggregate for one user
  task across one or more runs.
- Added `task_thread_update` session JSONL events so open task threads survive
  same-day daemon restart without appearing in the conversation timeline.
- Added `taskThreadContext` to the decision context pack with active task,
  suspended tasks, recent continuation signals, and suggested binding.
- Updated decision rules so the model continues, switches, starts new work, or
  asks on ambiguity using `context.taskThreadContext`.
- Updated tool selection so open task work, blockers, and assets influence the
  selected tool working set.
- Changed TaskSummary publication so open summaries update TaskThread first,
  while done task threads promote into Activity memory from the whole aggregate.
- Promoted remaining open task threads on session close so unfinished work stays
  recoverable after the user leaves the session.
- Kept explicit `activityId` summaries on the existing Activity path for
  durable activity continuation compatibility.
- Marked successful terminal replies with no open work, blockers, or user input
  need as `taskStatus: "done"` to avoid false-open task summaries.

## Current Contract

The runtime memory layers are:

```text
TaskSummary -> TaskThread -> Activity
```

- `TaskSummary` is an immutable one-run receipt.
- `TaskThread` is mutable same-session continuity for unfinished work.
- `Activity` is durable long-term memory for completed, abandoned, promoted, or
  explicitly selected work.

`runStatus` describes the run execution:

```text
completed | failed | stuck
```

`taskStatus` describes the user's task:

```text
done | open | blocked | needs_user_input
```

This state is valid and expected:

```text
runStatus: completed
taskStatus: open
```

It means the run ended normally, but the user task still has remaining work and
should continue through TaskThread.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main exec vitest run tests/memory/daily-session-manager.test.ts tests/memory/activity-store.test.ts tests/ivec/activity-continuation.test.ts tests/ivec/state-view.test.ts tests/ivec/agent-loop.test.ts tests/engine/engine.test.ts tests/pulse/proposal-reflection.test.ts
```

Both commands passed.
