# Task State Memory Cleanup

Date: 2026-07-07
Status: future plan

## Problem

Current task state is reliable, but `state.json` can become too mechanical for
agent working memory. It may include raw-ish tool execution summaries, JSON
snippets, byte counts, hash details, truncation notes, and verification
internals in fields that should be easy for the agent to understand quickly.

This is not urgent. It is a deferred quality improvement.

## Example

Current task memory may contain text like:

```text
Deterministic tool execution passed: write_files succeeded output="{ "filesWritten": 2, "totalBytes": 19808, "files": [ { "requestedPath": "index.html", "filePath": "/tmp/...", "bytesWritten": 8680, "sha2..."
```

This is useful evidence, but it is not good task memory.

Better task memory would say:

```text
Built a two-file tea stall website and updated it with a specials section and cleaner menu cards.
```

## Desired Separation

Keep detailed tool data in:

```text
steps/<runId>.jsonl
runs/<runId>.json
runs/<runId>.md
```

Keep `state.json` focused on:

- clean task summary
- concise completed work
- open work
- blockers
- next step
- verified user-relevant facts
- important files and artifacts
- clean search terms

## Why It Matters Later

`state.json` is intended to be the fast current task memory. If it contains too
many tool mechanics, the agent has to read through irrelevant details before it
understands the actual task.

No data should be lost. The detailed evidence should stay in step/run files.
The improvement is only about making `state.json` more useful as task memory.

## Future Direction

When this becomes active work:

1. Keep full step/tool/verification data in `steps/<runId>.jsonl`.
2. Keep compact run outcome in `runs/<runId>.json`.
3. Generate `state.json` from verified facts, task outcome, artifacts, and user
   relevant work state.
4. Prevent raw tool output snippets from becoming primary task summaries.
5. Build cleaner `context.searchTerms`, avoiding terms such as byte counts,
   `sha2`, `structuredContent`, and JSON-path verification internals.

## Expected Shape

Example target state:

```json
{
  "summary": "Built and updated a two-file tea stall website.",
  "progress": {
    "completed": [
      "Created index.html with hero, menu, specials, opening hours, and contact sections.",
      "Created styles.css with responsive layout and cleaner menu card styling."
    ],
    "open": [],
    "next": "No next step."
  },
  "context": {
    "importantFiles": ["index.html", "styles.css"],
    "searchTerms": [
      "tea stall",
      "website",
      "homepage",
      "stylesheet",
      "specials",
      "menu",
      "opening hours",
      "contact"
    ]
  }
}
```

## Status

Do not work on this now. Revisit after higher-priority git-context routing,
task search, and artifact ownership work is stable.
