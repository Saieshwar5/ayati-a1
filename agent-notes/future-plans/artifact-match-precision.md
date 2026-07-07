# Artifact Match Precision

Date: 2026-07-07
Status: future plan

## Problem

Git-context task search now finds the correct task using refs plus `state.json`,
including task artifact records. The remaining issue is artifact-level precision.

In the live daemon test, this query correctly found the tea stall website task:

```text
tea stall stylesheet
```

But `matchedArtifacts` included too many artifacts:

- `index.html`
- `styles.css`
- the workspace directory

The correct primary artifact should be:

- `styles.css`

The task match is good. The artifact match is too broad because each artifact
identity includes the task subject, such as "tea stall website", so all artifacts
receive points from task-level words.

## Why It Matters

Task search needs two different answers:

- Which task does this user message belong to?
- Which file or artifact inside that task is the user referring to?

Future agent decisions will depend on the second answer. Examples:

- `update the homepage` should point to `index.html`.
- `fix the stylesheet` should point to `styles.css`.
- `use the uploaded logo` should point to the user-provided logo file.
- `change the menu data file` should point to the relevant data file.

If artifact matching is too broad, the agent may read or edit extra files, waste
steps, and make weaker decisions.

## Direction

Keep the current simple architecture:

```text
git refs discover candidate tasks
state.json provides task and artifact memory
in-memory deterministic scorer ranks matches
```

Do not add a new index, database, vector store, or background indexing system.

Improve artifact scoring by separating task-subject tokens from
artifact-specific tokens.

Task-level scoring may use:

- title
- objective
- summary
- facts
- search terms
- artifact identities

Artifact-level scoring should primarily use:

- path
- filename
- original attachment name
- artifact type
- short aliases
- artifact label, such as `homepage`, `stylesheet`, `logo`, or `document`

Avoid treating long aliases like this as strong artifact-specific evidence:

```text
tea stall website index html styles css stylesheet
```

Those long aliases are useful for task search, but too broad for choosing the
specific matched artifact.

## Expected Behavior

```text
tea stall stylesheet
```

Expected task:

- tea stall website task

Expected matched artifact:

- `styles.css`

```text
tea stall homepage
```

Expected task:

- tea stall website task

Expected matched artifact:

- `index.html`

```text
uploaded logo
```

Expected matched artifact:

- the user attachment whose original name or identity is a logo

## Implementation Sketch

1. Add a helper that builds artifact-specific search fields.
2. Split task score and artifact score internally.
3. Keep task-subject tokens useful for task ranking.
4. Only include an artifact in `matchedArtifacts` when its artifact-specific
   score crosses a threshold.
5. Prefer exact path, filename, original name, artifact type, and short alias
   matches over long task-subject aliases.
6. Add tests for homepage, stylesheet, uploaded logo, and ambiguous same
   filename cases.

## Test Cases To Add Later

- `tea stall stylesheet` returns only `styles.css` as the matched artifact.
- `tea stall homepage` returns only `index.html` as the matched artifact.
- `uploaded logo` returns only the user-provided logo attachment.
- `styles.css` across two tasks is ambiguous unless task words disambiguate.
- `notes app stylesheet` picks the notes app task and its stylesheet.

## Live-Test Finding

The live daemon test on 2026-07-07 showed:

- task creation worked correctly
- same-task update reused the active task
- `searchTasks("tea stall stylesheet")` found the correct task
- `matchedArtifacts` was too broad

This is a quality improvement, not a blocker for the current task search work.
