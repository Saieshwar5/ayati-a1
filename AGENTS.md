# Repository Guidelines

## Project Structure & Module Organization

Ayati is a pnpm monorepo. Main packages:

- `ayati-main/`: backend agent daemon, provider adapters, memory, tools, plugins, WebSocket/HTTP servers, and tests.
- `ayati-cli/`: Ink/React terminal client.
- `ayati-learning-ui/`: learning UI/Tauri surface.
- `project-docs/`: stable product and engineering documentation. Start with `project-docs/README.md`.

Backend source lives in `ayati-main/src/`; tests mirror domains under `ayati-main/tests/` such as `tests/ivec`, `tests/engine`, `tests/skills`, and `tests/memory`.

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

## Testing Guidelines

Tests use Vitest. Add or update tests in the matching package/domain folder. Name test files `*.test.ts`. Prefer deterministic unit tests over networked provider calls. Run the smallest relevant test first, then broader commands for shared runtime changes.

## Commit & Pull Request Guidelines

Use short, lowercase, imperative commit subjects, for example `update context pack docs`. Pull requests should explain what changed, why, affected paths, and test evidence. Include screenshots or logs when UI, protocol, or artifact behavior changes.

## Security & Configuration Tips

Never commit secrets, `.env`, runtime data, generated artifacts, logs, or `dist/`. Treat shell, filesystem, Python, database, and external HTTP tools as high-privilege capabilities. Respect policies under `ayati-main/context/`.

## Agent-Specific Instructions

Preserve the current harness model: `context pack -> decision -> action executor -> deterministic verification -> progress reducer`. Do not reintroduce old controller stages or harness version switches.
