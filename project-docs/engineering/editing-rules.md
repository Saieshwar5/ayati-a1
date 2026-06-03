# Editing Rules

Protect user work:

- Always check worktree status before broad edits.
- Do not revert unrelated changes.
- If a file already has user changes, read it carefully before editing.

Code changes:

- Keep TypeScript strict and explicit.
- Preserve ESM import style.
- Use existing helper functions and services.
- Avoid ad hoc parsing when structured APIs exist.
- Keep public contracts compatible unless the request requires a breaking change.

Docs changes:

- Keep docs concise and actionable.
- Put stable context in `project-docs`.
- Put commit-by-commit implementation history in `project-docs/history/progress`.
- Do not put secrets or private credentials in docs.

Verification:

- Run the smallest meaningful test first.
- Run broader tests for shared runtime behavior.
- Report test failures honestly with the failing command.
