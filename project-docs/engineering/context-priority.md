# Context Priority

For most tasks, read in this order:

1. Root `README.md`.
2. `project-docs/product/overview.md`.
3. `project-docs/engineering/README.md`.
4. `project-docs/engineering/architecture/overview.md`.
5. `project-docs/engineering/architecture/workstreams-and-resources.md` for durable work.
6. `project-docs/engineering/architecture/agent-harness.md`.
7. `project-docs/engineering/conventions.md`.
8. Relevant source files.
9. Matching tests.

Core mental model to preserve:

```text
Ayati = persistent agent daemon + multiple communication clients + memory + tools + events
```

Current backend harness model:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

When choosing where to implement behavior:

- Daemon behavior belongs in `ayati-main`.
- Terminal UI behavior belongs in `ayati-cli`.
- New clients should connect to the daemon.

For backend runtime tasks, prioritize:

- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/src/ivec/agent-loop.ts`
- `ayati-main/src/ivec/agent-runner`
- `ayati-main/src/context`
- `ayati-main/src/prompt`
- `ayati-main/tests/ivec`

For context and memory tasks, prioritize:

- `project-docs/engineering/architecture/workstreams-and-resources.md`
- `project-docs/engineering/architecture/context-and-memory.md`
- `project-docs/engineering/architecture/agent-harness.md`
- `project-docs/engineering/env-vars.md` for runtime context configuration
- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`
- `ayati-context-engine/src`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-context-engine/src/runtime.ts`
- `ayati-main/src/skills/builtins/git-context`
- `ayati-context-engine/tests`
- `ayati-main/tests/skills/workstream-resource-routing.test.ts`
- `ayati-main/src/memory`
- `ayati-main/tests/memory`

For tool tasks, prioritize:

- `ayati-main/src/skills`
- `ayati-main/src/verification`
- `ayati-main/tests/skills`

For CLI tasks, prioritize:

- `ayati-cli/src/app`
- `ayati-cli/src/app/**/*.test.ts*`
