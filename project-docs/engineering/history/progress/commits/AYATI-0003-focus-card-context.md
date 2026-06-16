# AYATI-0003 Focus Card Context

## Context

The agent needed a stronger continuation model than `recentTasks`. The desired
boundary is:

- session JSONL stores only conversation and system events
- run artifacts store execution details
- focus cards store reusable tool-using work state
- attention shelf stores cross-session focus cards

The model-facing context should expose active and relevant focus cards directly
instead of a separate recent task summary list.

## Changes

- Added session/global focus-card scope to `FocusStore`.
- Added session focus card creation from tool-using task summaries.
- Kept no-tool direct replies from creating focus cards.
- Added activation state so selected cards appear in `activeFocus`.
- Added session close promotion from session focus cards to global attention
  shelf cards.
- Added focus tools:
  `focus_search`, `focus_get`, `focus_activate`, `focus_deactivate`,
  `focus_update`, `focus_list_session`, `focus_list_attention`, and
  `focus_list_active`.
- Wired the shared focus store through runtime memory and dynamic skill
  activation.
- Replaced model-facing `recentTasks` with `activeFocus`,
  `sessionFocusCards`, and `attentionShelf`.
- Kept legacy `recentTaskSummaries` only as an empty compatibility field and
  old-state cleanup key.
- Updated Pulse proposal reflection to use focus-card context instead of recent
  task summaries.

## Current Contract

Focus cards are stored in `data/memory/memory.sqlite`, not in session JSONL.

Session focus cards are created after a task run only when `toolsUsed` is
non-empty. They are shown in the current session through `sessionFocusCards`.

Focus tools can activate a card for the current session. Activated cards appear
in `activeFocus`.

When a session closes, durable session focus cards are promoted or merged into
global cards. Global cards power `attentionShelf`.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test
```

Both commands passed. The full backend suite reported 82 test files passed and
521 tests passed.

## Follow-Ups

- Decide whether source tracking should become a first-class `sourceState`
  alongside `workState`.
