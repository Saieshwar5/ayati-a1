# Tool Contracts

Built-in skills should behave like tools with machine-checkable contracts, not
plain text commands.

Core idea:

```text
structured tool result -> contract assertions -> verified facts -> progress reducer
```

## Tool Result Model

Tools can return structured result data alongside the older text output. The
important fields are:

- transport success
- operation status
- stable code/message
- structured content
- artifacts
- structured error
- verification result

This separates "the tool returned JSON" from "the requested operation
succeeded."

## Tool Definition Metadata

Tool definitions can declare:

- `inputSchema`
- `outputSchema`
- annotations such as read-only, workspace mutation, destructive, idempotent, retry-safe, long-running, and domain
- `resultContract`
- `errorContract`

The decision model sees annotations and schemas. The executor and verification
layer use contracts to prove outcomes.

## Verification Path

For a deterministic action:

1. Validate action plan.
2. Validate each tool input.
3. Execute tool calls.
4. Normalize result.
5. Run tool-owned result contract.
6. Run action-level assertions when supplied.
7. Extract artifacts and verified facts.
8. Reduce progress from verified evidence.

This keeps common work fast because no extra verifier model call is needed.

## Good Contract Examples

Filesystem writes should prove:

- requested files were written
- parent directory policy was respected
- paths exist
- read-back hashes match requested content
- artifacts reference the written files

Shell work should prove:

- command exit code
- stdout/stderr capture
- timeout status
- artifact paths when generated

Database work should prove:

- target database path
- statement mode
- affected row count or query rows
- schema/data state when needed

Document tools should prove:

- document ID or prepared input ID
- section/chunk sources
- retrieval/query evidence
- exact paths or manifest references when available

## Progress Facts

Verified facts should be short, factual, and grounded in tool evidence.

Examples:

- `todo/index.html exists`
- `write_files read-back hash matched for todo/app.js`
- `shell command pnpm test exited 0`
- `document_query returned section evidence from contract.pdf`

Avoid storing vague facts such as "the task is probably done" when a more
specific machine-checkable fact is available.

## Failure Contracts

Stable error codes enable local recovery.

Examples:

- `PARENT_DIR_MISSING` -> retry write with `createDirs=true`
- `VALIDATION_ERROR` -> ask for corrected input or choose a valid schema
- `PERMISSION_DENIED` -> block or ask user
- `TIMEOUT` -> reduce scope or ask user before retrying expensive work

## Migration Rule

When updating or adding a built-in tool, prefer adding a contract at the same
time. A broad tool without contracts increases token use and forces the model to
guess whether work succeeded.
