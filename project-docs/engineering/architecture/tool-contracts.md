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

The decision model receives native input schemas and a compact grouping of
selected tool names by purpose. Output contracts, annotations, and effects stay
runtime-owned. The executor and verification layer use them to prove outcomes.

## Purpose and Effect Policy

Every built-in executable tool has one primary model-facing purpose:

- `read`: retrieve a known target or inspect known state
- `search`: discover, filter, or locate an unknown target
- `control`: change harness workflow or lifecycle state
- `mutation`: change user data, workspace state, memory, UI state, or an
  external system

Purpose explains why the model would choose the tool. It does not grant
permission. Safety is an orthogonal runtime-owned effect:

- `read_only`
- `workspace_mutation`
- `context_mutation`
- `external_mutation`
- `destructive`

Read and search are observational purposes and currently require a read-only
effect to run before task binding. They are not described as harmless: they can
still expose sensitive data, consume time, or return untrusted content. Control
is also not synonymous with safe. For example, task activation has purpose
`control` and effect `context_mutation`.

Native harness controls—`decision_load_tools`, `ask_user_feedback`, and
`task_completion`—share the same control-purpose registry even though they are
not executable catalog tools. This keeps provider surface filtering, prompt
grouping, feedback, and policy checks on one vocabulary.

## Single Capability Ownership

Each model-facing intent has one canonical tool owner. Batching related targets
is allowed, but a public tool should not select unrelated operations through an
`action` field, duplicate another public tool, or change between observational
and mutating behavior through an automatic mode.

Project process execution is intentionally narrow:

- `process_run` runs one non-interactive executable with a structured argument
  array.
- `process_start` starts one long-running executable.
- `process_poll` consumes incremental output without sending input or stopping it.
- `process_send_input` sends stdin without consuming output or stopping it.
- `process_stop` stops one process and returns its final status/output.

There is no command-string tool or separate script alias. Shell interpreters,
inline interpreter code, and direct filesystem, search, SQLite, Git, Python,
or URL-fetch commands are rejected because focused tools own those
capabilities. `process_run` and `process_start` are still treated as
mutation-capable. A synchronous `process_run` without declared file targets
receives context-only mutation authority; any unexpected repository change
fails mutation verification. A long-running `process_start` must declare its
bounded mutation targets because later process changes cannot be verified at
start time.

## Host Filesystem Path Contract

Every model-facing field that addresses a host file or directory uses a
canonical absolute path. This includes filesystem paths, search roots, process
working directories and scripts, Python datasets/scripts/input files, supplied
SQLite database paths, and generated artifact registration paths. An omitted
optional path may use a runtime-owned absolute default.

Relative paths, `.`, `..`, `~/...`, `workspace/...`, and `work_space/...` are
rejected with `ABSOLUTE_PATH_REQUIRED`; they are not silently repaired. During
a task, absolute paths are canonicalized through symlinks and must remain
inside the task `workingDirectory`. Absolute syntax and authorization are
separate checks.

Tool results, evidence, task assets, completion assets, and final file
references preserve the same absolute identity. Git alone receives a private
portable task-relative path, derived after authorization. Relative references
inside generated content—such as `./styles.css` in HTML or source imports—are
normal project content and remain valid.

## Task Routing Contract

`git_context_find_tasks` searches durable work by explained deterministic
reasons, and `git_context_read_task` opens one candidate without binding it.
`git_context_set_task_star` changes only an explicit user preference.
`git_context_inspect_task_location` is a pre-binding control that may create a
short-lived approval receipt but never changes the inspected directory.

The model-facing routing tools are `git_context_create_task` and
`git_context_activate_task`. They are single-use control-purpose tools with a
context-mutation effect, not general filesystem tools.

`git_context_create_task` creates a new V1 repository and initial request. It
may use managed placement or a requested directory that passed the trusted
registration policy.
`git_context_activate_task` selects an existing task; for V1 it must submit one
of these explicit decisions:

- `requestDecision.kind="continue"` with the exact unfinished request id
- `requestDecision.kind="create"` with the new request details

Both return the task/run identity, stable working directory, and refreshed
harness context containing the selected request. V1 never requires a mount.
The model must not edit `.ayati/`, commit, or manufacture task/request
identifiers itself.

Model-facing operations derive replay identity from the immutable run id and
native tool-call id. A transport retry of the same logical call is idempotent;
a genuinely new model call is a new decision and therefore a new operation.

## Task Mutation and External Outcomes

Task-scoped filesystem, process, Python, and database paths must remain inside the
selected task working directory unless a separate capability explicitly allows
another boundary. Symlink canonicalization must happen before authorization.

External actions—browser interaction, desktop control, remote APIs, messages,
or changes outside the repository—cannot be proven by a task commit alone.
Their contracts should return a compact outcome, target, timestamp, and
verification/evidence pointer while excluding secrets and uncontrolled raw
transcripts. The standardized durable task format for these outcomes is still
deferred.

## Verification Path

For a deterministic action:

1. Validate action plan.
2. Validate each tool input.
3. Execute tool calls.
4. Normalize result.
5. Run tool-owned result contract.
6. Apply action-executor verification gates.
7. Run action-level assertions when supplied.
8. Extract artifacts and verified facts.
9. Reduce progress from verified evidence.

This keeps common work fast because no extra verifier model call is needed.

The gate layer separates execution status from validation status:

- all tool calls failed: execution failed, validation skipped
- no tool output and no final text: execution failed, validation skipped
- required contract assertion failed: execution may have succeeded, validation failed
- known deterministic output shape passed: validation passed through a script gate
- successful tool output without a contract or deterministic gate: execution
  succeeded, but validation remains skipped

Only contract-backed facts, deterministic success-gate evidence, and artifacts
should update progress as verified work.

## Good Contract Examples

Filesystem inspection should prove:

- requested paths were inspected
- each path's existence and kind: file, directory, symlink, missing, or other
- size and modified time when available
- line count when requested and practical
- content/language hints when detectable
- directory child counts when requested
- read recommendation for whether to read directly, read a range, search, or
  inspect deeper first

Filesystem reads should prove:

- requested path or paths were resolved
- range, truncation, and `hasMore` status are explicit
- output shape is clear for single-file and multi-file reads
- broad or risky reads produce advisory feedback when metadata should be used
  first
- raw output is available as run evidence when it is too large for prompt use

Filesystem writes should prove:

- requested files were written
- parent directory policy was respected
- paths exist
- read-back hashes match requested content
- artifacts reference the written files

Process execution should prove:

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

- `/home/user/project/todo/index.html exists`
- `write_files read-back hash matched for /home/user/project/todo/app.js`
- `process_run pnpm test exited 0`
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

Read advisories are intentionally softer than failure contracts. For example,
`FILE_METADATA_RECOMMENDED` tells the model that `inspect_paths` would likely
help before another broad or truncated read. The read may still succeed; the
advisory exists to improve the next decision without adding a separate intent
classifier.

## Migration Rule

When updating or adding a built-in tool, add its purpose/effect taxonomy and
prefer adding a contract at the same time. Missing taxonomy fails policy audit;
a broad tool without contracts increases token use and forces the model to
guess whether work succeeded.
