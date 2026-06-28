# Repository Guidelines

Read `../project-docs/README.md` before major design changes. For current
agent architecture, start with:

- `../project-docs/engineering/architecture/agent-harness.md`
- `../project-docs/engineering/architecture/context-and-memory.md`
- `../project-docs/engineering/architecture/tool-contracts.md`

## Project Structure & Module Organization

- `src/` contains runtime code.
- Core areas:
  - `src/app`: bootstrap/startup wiring.
  - `src/ivec`: `IVecEngine`, decision-action-reducer runner, context pack, state view, tool selection, progress reduction, and system-event policy.
  - `src/ivec/agent-runner`: current harness implementation.
  - `src/memory`: session persistence, personal memory, episodic memory, and recall.
  - `src/skills`: built-in/runtime tools, contracts, guardrails, and tool execution.
  - `src/providers`: LLM provider adapters.
  - `src/server`: WebSocket, HTTP upload/artifact, and integration transport surfaces.
- `tests/` mirrors runtime domains (`tests/engine`, `tests/ivec`, `tests/skills`, etc.).
- `context/` stores stable prompt and policy config.
- `data/` is runtime output and is ignored by git.

## Build, Test, And Development Commands

- `pnpm build` compiles TypeScript to `dist/`.
- `pnpm start` runs the compiled server (`node --env-file=.env dist/index.js`).
- `pnpm dev` watches `src/**/*.ts`, rebuilds, and restarts.
- `pnpm test` runs all Vitest suites once.
- `pnpm test:watch` runs Vitest in watch mode.

## Harness Rules

- Preserve the current loop: `context pack -> decision -> action executor -> deterministic verification -> progress reducer`.
- Do not reintroduce separate controller stages or harness version switches.
- Put dynamic runtime context in the structured state/context pack when possible.
- Treat optional git context as task continuity, not proof.
- Prefer deterministic tool contracts/assertions over extra model verification.

## Coding Style & Naming Conventions

- Language: TypeScript (ESM, strict mode).
- Use 2-space indentation, semicolons, and double quotes to match existing files.
- Prefer small focused modules and explicit types for public interfaces.
- File naming: kebab-case.
- Test files: `*.test.ts` under `tests/` with domain-based folders.

## Testing Guidelines

- Framework: Vitest (`vitest.config.ts` includes `tests/**/*.test.ts`).
- Add or extend tests in the matching domain folder when changing behavior.
- Prefer deterministic unit tests over networked/integration dependencies.
- Before opening a PR, run: `pnpm build && pnpm test`.

## Commit & Pull Request Guidelines

- Existing history uses short, lowercase, imperative summaries.
- Keep commit subjects concise and scoped to one logical change.
- PRs should include what changed, why, impacted paths, and test evidence.

## Security & Configuration Tips

- Never commit secrets; `.env` is ignored.
- Respect tool guardrails in `context/tool-access.json`.
- Do not commit generated artifacts (`dist/`, `data/`, logs, temp files).
