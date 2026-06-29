# Repository Guidelines

## Project Structure & Module Organization

Ayati is a pnpm monorepo. Main packages:

- `ayati-main/`: backend agent daemon, provider adapters, memory, tools, plugins, WebSocket/HTTP servers, and tests.
- `ayati-cli/`: Ink/React terminal client.
- `project-docs/`: stable product and engineering documentation that helps coding agents understand Ayati before making major changes. Start with `project-docs/README.md`.

Backend source lives in `ayati-main/src/`; tests mirror domains under `ayati-main/tests/` such as `tests/ivec`, `tests/engine`, `tests/skills`, and `tests/memory`.

`project-docs/` is the stable AI-agent context layer for Ayati. It explains the product, architecture, harness model, memory/context design, testing expectations, and engineering history. Before significant implementation work, read the relevant docs listed in `project-docs/README.md`, especially the product overview, engineering README, architecture overview, agent harness, context/memory, and testing docs.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies.
- `pnpm build`: build all workspace packages.
- `pnpm test`: run all workspace tests.
- `pnpm dev:main`: watch/restart the backend daemon.
- `pnpm start:main`: run the compiled backend.
- `pnpm dev:cli`: run the terminal client in development.
- `pnpm doctor:main`: run backend environment checks.

For focused backend work, use `pnpm --filter ayati-main build` and `pnpm --filter ayati-main test`.

## Coding Style & Naming Conventions

Use TypeScript ESM with strict, explicit types for public interfaces. Match existing formatting: 2-space indentation, semicolons, and double quotes. Prefer small modules and existing local helpers over new abstractions. File names are kebab-case, for example `context-pack.ts` and `session-manager.ts`.

Choose common, well-understood implementation techniques over obscure or rarely used language features. Keep the codebase highly organized and easy for humans to understand. Do not use complicated techniques unless they provide clear, meaningful value for the problem being solved.

The preferred design style is simple, organized, efficient, powerful, clean, and reliable. Favor direct control flow, explicit data shapes, deterministic behavior, and code that future maintainers can read without needing to reverse-engineer cleverness.

## Testing Guidelines

Tests use Vitest. Add or update tests in the matching package/domain folder. Name test files `*.test.ts`. Prefer deterministic unit tests over networked provider calls. Run the smallest relevant test first, then broader commands for shared runtime changes.

## Commit & Pull Request Guidelines

Use short, lowercase, imperative commit subjects, for example `update context pack docs`. Pull requests should explain what changed, why, affected paths, and test evidence. Include screenshots or logs when UI, protocol, or artifact behavior changes.

## Branching Guidance

Before editing, check `git status --short` and decide whether the work belongs on
the current branch or a new one.

- Use the current branch for small, low-risk follow-ups:
  - typo fixes
  - wording-only docs changes
  - comment cleanup
  - formatting-only updates
  - continuation work already scoped to the active task
- Use a new branch for higher-risk or behavior-changing work:
  - code changes
  - dependency changes
  - config, policy, or state changes
  - schema or API changes
  - multi-file refactors
- Branch names should be short and lowercase, using a prefix such as `fix/`,
  `feat/`, `docs/`, `chore/`, `refactor/`, or `test/`.
- State the branch decision before editing when it matters for the task.

## Security & Configuration Tips

Never commit secrets, `.env`, runtime data, generated artifacts, logs, or `dist/`. Treat shell, filesystem, Python, database, and external HTTP tools as high-privilege capabilities. Respect policies under `ayati-main/context/`.

## Agent-Specific Instructions

Preserve the current harness model: `context pack -> decision -> action executor -> deterministic verification -> progress reducer`. Do not reintroduce old controller stages or harness version switches.

For local external reference projects that may help with architecture, memory,
agent harness, plugin, CLI, or developer-tool comparisons, see
`reference-projects/`.

For user ideas, plans, decisions, and next-action notes that should guide what
the agent works on next, check `agent-notes/`. Keep `project-docs/` for stable
project knowledge about what Ayati is and how it works.
