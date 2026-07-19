# Tool Contracts

Built-in capabilities use machine-checkable contracts:

```text
structured result -> deterministic assertions -> verified facts -> progress reducer
```

## Purpose and Effect

Every executable tool has one purpose:

- `list`
- `read`
- `search`
- `control`
- `mutation`

Purpose explains why the model chooses a call. Runtime-owned effect determines
safety:

- `read_only`
- `workspace_mutation`
- `context_mutation`
- `external_mutation`
- `destructive`

Unknown classifications fail closed. Native controls such as
`decision_load_tools`, `ask_user_feedback`, and `workstream_completion` share
the control taxonomy but are not ordinary executable catalog tools.

## Tool Metadata

A tool can declare native input/output schemas, annotations, a result contract,
and an error contract. The model sees the selected names and input schemas.
The executor owns effects, output validation, and verified-fact extraction.

## Host Paths and Resources

Model-facing host paths are canonical absolute paths. Relative paths, `.`,
`..`, and `~` are rejected rather than repaired. Syntax validation does not
grant access.

For unbound observation, reads are limited to the default workspace and
admitted ingress resources. After binding, each call must resolve to a
workstream resource. Directory resources allow descendants; file resources
allow only the exact file. Mutation additionally requires `access: "mutate"`
and a verified resource-mutation operation.

Process tools declare their relevant working directory and exact mutation
targets. Long-running processes cannot receive open-ended filesystem access.
Unexpected changes fail verification.

## Workstream Controls

Discovery controls:

- `git_context_find_workstreams`
- `git_context_read_workstream`
- `git_context_inspect_resource`
- `git_context_set_workstream_star`

Routing controls:

- `git_context_create_workstream`
- `git_context_activate_workstream`
- `git_context_bind_resources`

Reading never binds. Creating or activating binds the same run. Activating an
existing workstream must continue an exact active request or create a new
request. Replay identity derives from run id and native tool-call id.

## Verification Path

1. Validate the action plan and tool input.
2. Resolve resource ownership and prepare exact mutation observations when
   required.
3. Execute the call.
4. Normalize its structured result.
5. Run tool-owned contracts and action assertions.
6. Verify resource effects.
7. Extract artifacts and grounded facts.
8. Reduce WorkState and persist one run step.

Tool success and validation success are distinct. Only contract-backed facts,
deterministic evidence, and verified artifacts advance progress.

## Failure Contracts

Stable codes should name recoverable conditions such as invalid input, missing
path, stale version, denied resource access, timeout, verification failure, or
missing workstream binding. Repairs are fed back into the next model decision;
failed mutations are never deferred or replayed.

When adding a tool, add its taxonomy and contracts in the same change. Broad
multi-operation tools and unclassified behavior are rejected by policy audit.
