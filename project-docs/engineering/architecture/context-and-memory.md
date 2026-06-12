# Context And Memory

Ayati should feel continuous without asking the user to manage sessions,
threads, or context windows manually.

Current runtime model:

```text
session memory + focus cards + runtime context -> context pack -> decision state view
```

## Context Pack

The decision model receives dynamic runtime context through
`State view.context`, built by:

- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`

The context pack is bounded JSON. It can include:

- `currentInput`
- `runtime`: date, time, timezone, weekday
- `session`: session path, context pressure, age, turn count, handoff state
- `attentionShelf`: compact focus summaries
- `recentExact`: last few conversation turns
- `recentTasks`: recent task summaries
- `activeAttachments`: recently used documents/files
- `previousSessionSummary`
- `personalMemorySnapshot`
- `activeLearningContext`
- `recentSystemActivity`

The system prompt should contain stable rules. Dynamic memory should be in the
context pack whenever possible.

## Focus Cards

Focus cards are durable records for meaningful ongoing work, not every message.
They are stored by the memory layer and summarized into the attention shelf.

Current focus types:

- `artifact_work`
- `document`
- `learning`
- `automation`
- `investigation`
- `debug_issue`
- `generic_task`

Focus cards store:

- label and summaries
- entities/hints
- artifacts and document references
- verified facts
- open work and next step
- source run IDs
- memory strength, decay rate, importance, reuse count
- timestamps and attention score inputs
- type-specific details

## Attention Shelf

The attention shelf is a small list of high-lifespan or recently touched focus
items. It gives the decision model continuity hints without loading full
history.

Shelf items include:

- `focusId`
- type/status
- label and compact summary
- hints
- top artifacts
- last touched time
- attention score
- next step when available

Use shelf items only when relevant to the current input. They are not proof;
important claims should still be verified through files, documents, tool
results, or recall.

## Runtime Flow

For each user message:

1. `IVecEngine` starts or continues a session run.
2. Session memory returns conversation turns, recent task summaries, active attachments, attention shelf, personal memory, and system activity.
3. The runner syncs those transient values into `LoopState`.
4. `context-pack.ts` compacts them into bounded JSON.
5. `state-view.ts` includes the context pack in the decision prompt.
6. Tool results and task summaries update memory after the run.
7. Focus cards are created or updated from task summaries and active attachments.

## Current Limitation

The attention shelf is visible to the decision model, but full focus-card
activation is not complete yet.

Next improvement:

```text
attention shelf -> activeFocus / possibleFocus -> optional full focus load -> decision
```

This should let the agent confidently resume recent or high-lifespan work while
still asking the user before risky ambiguous actions.
