# AI Agent Instructions

Before making code changes:

1. Read `project-docs/README.md`.
2. Read the relevant product and engineering docs.
3. Inspect existing source files and tests in the target domain.
4. Check `git status --short` and do not overwrite unrelated user changes.

Working rules:

- Keep changes scoped to the request.
- Treat `ayati-main` as the persistent agent daemon.
- Treat `ayati-context-engine` as the sole owner of Context Engine SQLite and Git
  mutations; use its typed service interface from the daemon.
- Treat `ayati-cli` as one client surface, not the owner of agent intelligence.
- Treat `src/ivec/agent-runner` as the current harness implementation.
- Preserve the decision-action-reducer model: context pack, decision, action executor, deterministic verification, progress reducer.
- Prefer existing patterns over new abstractions.
- Do not introduce dependencies casually.
- Do not commit secrets or runtime data.
- Do not edit `ayati-main/data/` unless the task explicitly concerns runtime fixtures or local debugging.
- Update docs when behavior, architecture, API contracts, env vars, or workflows change.
- Run relevant tests when feasible and report what was run.

Product rules:

- Do not assume Ayati is CLI-only.
- Keep core intelligence, memory, tools, provider access, permissions, and background event processing in the daemon.
- Memory is product-critical because it gives continuity and personalization.
- Context-only workstream repositories and the resource catalog are the
  durable-work source. `W-*` repositories contain `workstream.md`, request
  files, and `resources.json`; never put deliverables in them.
- Preserve the git-native ownership boundary: the agent may discover/open
  context, inspect resources, and select/create workstreams through typed Git
  Context tools, but runtime owns identity allocation, request reduction,
  resource verification, finalization, and context commits.
- For activation, explicitly pass `requestDecision.kind="continue"` or
  `requestDecision.kind="create"`. A candidate or previously active workstream is
  not mutation authority.
- Use real resource locators for work. Do not edit context repositories or
  runtime-owned `.ayati/` state from general tools.
- Tool access is high privilege because the daemon can affect the user's computer.
- Tool results should become verified facts through contracts/assertions whenever deterministic verification is possible.
- Future communication channels should connect to the daemon instead of duplicating core runtime logic.

Important source entry points:

- `ayati-main/src/app/main.ts`
- `ayati-context-engine/src/runtime.ts`
- `ayati-context-engine/src/services/sqlite-context-engine-service.ts`
- `ayati-main/src/app/context-engine-runtime.ts`
- `ayati-main/src/ivec/index.ts`
- `ayati-main/src/ivec/agent-runner/runner.ts`
- `ayati-main/src/ivec/agent-runner/context-pack.ts`
- `ayati-main/src/ivec/agent-runner/state-view.ts`
- `ayati-main/src/skills/tool-executor.ts`
- `ayati-main/src/server/ws-server.ts`
- `ayati-main/src/server/upload-server.ts`
- `ayati-cli/src/app/app.tsx`

Before changing durable-work continuity, read
[Workstreams and Resources](architecture/workstreams-and-resources.md) and update it when the
stable contract changes.
