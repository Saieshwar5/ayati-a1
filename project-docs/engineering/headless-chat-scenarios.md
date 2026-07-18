# Headless Chat Scenarios

This guide explains how another coding agent can use Ayati like a human user
for multi-turn development and evaluation. It does not require daemon core
changes.

## Purpose

Use this workflow when an external coding agent needs to test Ayati through the
same path a person uses in the terminal client.

Good uses:

- Ask Ayati to perform real tasks after code changes.
- Exercise multi-turn clarification flows.
- Verify that task routing, tool use, final replies, feedback traces, and git
  context behave correctly.
- Produce a report that says what worked, what failed, and what should improve.

Do not use system events for this human-parity workflow. System events have
their own policy, input kind, response behavior, and tool exposure. They are
useful later as automation triggers, but they are not the same as human chat.

## Existing Support

Ayati already supports external clients through the WebSocket chat transport:

```text
ws://localhost:8080
```

Send the same normalized chat payload that the CLI sends:

```json
{
  "type": "chat",
  "content": "Create a txt file with 10 Linux commands."
}
```

This enters the normal human-message path:

```text
WebSocket
-> IVecEngine.handleMessage
-> ChatTurnRuntime.processChat
-> Git Context session repository and SQLite run lifecycle
-> explicit V1 task/request selection when mutation is needed
-> agent loop inputKind=user_message
-> reply / feedback / progress / error
```

## Start Ayati For Evaluation

For evaluation, start the daemon with feedback tracing enabled:

```bash
pnpm dev:main:feedback
```

or, after building:

```bash
pnpm start:main:feedback
```

These commands set:

```env
AYATI_TEST_AGENT=1
AYATI_FEEDBACK_TRACE=1
```

The feedback ledger writes operator-facing trace files under:

```text
ayati-main/data/feedback/
```

If an external coding agent starts the daemon itself, it should also capture
daemon stdout/stderr for its own report.

## Multi-Turn Rule

The coding agent may send many messages, but it must behave like the CLI:

```text
send one message
wait until the turn is finished
inspect the response and feedback data
then send the next message
```

Do not send overlapping chat messages. The CLI prevents this with its loading
state, but the daemon does not currently serialize arbitrary external clients
for them. A headless client must enforce this rule itself.

Bad:

```text
send message 1
send message 2 immediately
send message 3 immediately
```

Good:

```text
send message 1
wait for final reply / feedback / error
send message 2
wait for final reply / feedback / error
send message 3
```

## Response Types

The daemon can send these WebSocket messages:

```text
progress      intermediate work update
reply         final assistant answer
feedback      final user-input request
notification  final only when final=true
error         final failed turn
reply_started start of a streamed final assistant answer
reply_delta   streamed final assistant text chunk
reply_done    final marker for streamed assistant answer
```

The coding agent should treat a turn as finished when it receives:

- `reply`
- `feedback`
- `error`
- `notification` with `final: true`
- `reply_done`

`progress`, `reply_started`, and `reply_delta` are not final. Keep them in the
transcript, then continue waiting. For streamed replies, `reply_done.content`
is the full assembled assistant response and `reply_done.commitStatus` says
whether the response was committed, skipped because no task commit was needed,
or failed during finalization.

## Feedback Questions

When Ayati sends `feedback`, it is asking for more information during a task
run.

Example:

```json
{
  "type": "feedback",
  "content": "What kind of website should I build?"
}
```

The coding agent should respond with the next normal chat message:

```json
{
  "type": "chat",
  "content": "Build a coffee shop website with a dark theme and menu section."
}
```

Do not call a special feedback endpoint. The answer should go through normal
chat so it is recorded in the same session conversation and processed through
the same context engine path as a human response.

## Scenario Shape

A scenario is a planned conversation. It can be represented by a simple JSON
shape outside the daemon:

```json
{
  "name": "coffee_shop_website",
  "messages": [
    "Build a simple website for me.",
    "Make it for a coffee shop with a dark theme.",
    "Create the files now and tell me where they are."
  ]
}
```

The runner or coding agent should execute it as:

```text
for each message:
  send chat payload
  collect progress messages
  wait for final response
  read feedback summaries
  decide whether to continue, stop, or report failure
```

The scenario may end early if Ayati returns `error`. It may also pause if Ayati
returns `feedback` and the scenario does not include enough information to
answer.

## Feedback Files To Read

When feedback tracing is enabled, read these files after each turn:

```text
ayati-main/data/feedback/latest-session.json
ayati-main/data/feedback/latest-summary.json
ayati-main/data/feedback/triage-summary.json
```

For raw turn-level events, use the session JSONL file referenced by
`latest-session.json`, usually:

```text
ayati-main/data/feedback/YYYY-MM-DD/session-<sessionId>.jsonl
```

The triage summary is the highest-signal file for quick evaluation. It tells
whether the latest run is healthy, needs review, or failed, and lists repair or
runtime findings.

Generate a readable lifecycle report for the latest trace with:

```bash
pnpm feedback:git-context
```

Or point it at an exact captured trace:

```bash
pnpm feedback:git-context -- --input ayati-main/data/feedback/YYYY-MM-DD/session-<sessionId>.jsonl
```

The report correlates daemon and Git Context transport events, checks paired
operations, and renders one lifecycle row per task run. Read the row from left
to right: task/run identity, selection mode, explicit request decision,
request identity, stable working directory, finalization, and commit.

## V1 Repository Acceptance

Do not judge a durable scenario only from its final reply. After a task turn,
use the Git Context trace/catalog data to locate the selected `T-*` repository
and verify:

- it is a normal independent Git repository;
- the working directory is the stable task repository;
- `.ayati/task.md` describes the current state and next step;
- `.ayati/requests/` records the selected request and outcome;
- `.ayati/inbox/` remains ignored;
- curated references are tracked deliberately;
- the deliverable exists beside `.ayati/`;
- finalization produced the expected single task commit; and
- reopening after daemon restart selects the same repository and requires the
  intended continue-vs-new-request decision.

Cross-check these repository facts against
`latest-summary.json.contextEngine.taskLifecycle`. Treat disagreement between
the feedback lifecycle and the repository itself as a test failure even when
the final reply sounds correct.

For a new task, expect a `T-*` identity.

Recommended scenario families:

- learning: add a lesson, stop, reopen, continue it, then create the next
  request in the same task;
- website: create a site, reopen it, add a feature, and verify existing files
  and Git ancestry remain intact;
- analysis: attach data, keep large inputs out of Git, and persist compact
  conclusions/references;
- automation: verify both repository artifacts and external outcomes, clearly
  marking anything the current evidence contract cannot prove.

## Report Expectations

After a scenario, the coding agent should produce a report with:

- scenario name
- daemon start mode and whether feedback tracing was enabled
- every user message sent
- every Ayati `reply`, `feedback`, `notification`, `error`, and `progress`
- duration per turn
- final response type per turn
- feedback triage outcome per turn
- important repair codes or warning signals
- artifacts or files the scenario expected
- whether expected files exist
- selected task id, request decision/id, stable working directory, and commit
- `.ayati/` contract and ignored-inbox inspection result
- restart/reopen result when continuity is part of the scenario
- whether the final answer was useful to a human
- suggested improvements if behavior was poor

Example report outline:

```markdown
# Ayati Chat Scenario Report

Scenario: coffee_shop_website
Overall: needs_review

## Turns

1. User: Build a simple website for me.
   Ayati: Asked for requirements.
   Triage: healthy

2. User: Make it for a coffee shop with a dark theme.
   Ayati: Created files and reported paths.
   Triage: healthy

## Findings

- Final response included file paths.
- No provider errors.
- No missing-work-run repair.

## Suggested Improvements

- None.
```

## What Not To Do

- Do not use `system_event` when the goal is to test human chat behavior.
- Do not send multiple chat messages before the previous turn finishes.
- Do not ignore `feedback`; treat it as Ayati asking the user a question.
- Do not judge success only from the final text. Also read feedback triage and
  inspect created files or artifacts.
- Do not make the external coding agent modify daemon internals just to run a
  scenario.

## Future Improvements

These are optional protocol improvements if the external workflow becomes
important enough:

- Add optional `requestId` to chat payloads and echo it in responses.
- Add daemon-side per-client turn serialization for poorly behaved clients.
- Add a dev-only feedback-report API if file reading becomes inconvenient.
- Add a small headless scenario runner script once the instructions prove
  stable.

Keep these changes outside the agent loop and git context core unless there is
a concrete reason to change core runtime behavior.
