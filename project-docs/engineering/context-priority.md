# Context Priority

For most tasks, read in this order:

1. Root `README.md`.
2. `project-docs/product/overview.md`.
3. `project-docs/architecture/overview.md`.
4. `project-docs/engineering/conventions.md`.
5. Relevant domain doc under `project-docs`.
6. Relevant source files.
7. Matching tests.

Core mental model to preserve:

```text
Ayati = persistent agent daemon + multiple communication clients + memory + tools + events
```

When choosing where to implement behavior:

- Daemon behavior belongs in `ayati-main`.
- Terminal UI behavior belongs in `ayati-cli`.
- New clients should connect to the daemon.

For backend runtime tasks, prioritize:

- `ayati-main/src/app/main.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/src/ivec/agent-loop.ts`
- `ayati-main/src/context`
- `ayati-main/src/prompt`
- `ayati-main/tests/ivec`

For tool tasks, prioritize:

- `ayati-main/src/skills`
- `ayati-main/tests/skills`

For memory tasks, prioritize:

- `ayati-main/src/memory`
- `ayati-main/tests/memory`

For CLI tasks, prioritize:

- `ayati-cli/src/app`
- `ayati-cli/src/app/**/*.test.ts*`
