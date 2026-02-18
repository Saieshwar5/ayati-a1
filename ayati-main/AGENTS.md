# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains runtime code.
- Core areas:
  - `src/app` bootstrap/startup wiring.
  - `src/ivec` agent loop and tool selection.
  - `src/memory` session persistence, summaries, drift/context services.
  - `src/skills` built-in and external tools/guardrails.
  - `src/providers` LLM provider adapters (`openai`, `anthropic`).
  - `src/server` WebSocket transport.
- `tests/` mirrors runtime domains (`tests/engine`, `tests/ivec`, `tests/skills`, etc.).
- `context/` stores prompt and tool-access config. `data/` is runtime output (ignored by git).
- `AGENT.md` documents architecture direction; read it before major design changes.

## Build, Test, and Development Commands
- `npm run build` compiles TypeScript to `dist/`.
- `npm start` runs the compiled server (`node --env-file=.env dist/index.js`).
- `npm run dev` watches `src/**/*.ts`, rebuilds, and restarts.
- `npm test` runs all Vitest suites once.
- `npm run test:watch` runs Vitest in watch mode.

## Coding Style & Naming Conventions
- Language: TypeScript (ESM, strict mode).
- Use 2-space indentation, semicolons, and double quotes to match existing files.
- Prefer small focused modules and explicit types for public interfaces.
- File naming: kebab-case (examples: `session-manager.ts`, `tool-access-config.ts`).
- Test files: `*.test.ts` under `tests/` with domain-based folders.

## Testing Guidelines
- Framework: Vitest (`vitest.config.ts` includes `tests/**/*.test.ts`).
- Add/extend tests in the matching domain folder when changing behavior.
- Prefer deterministic unit tests over networked/integration dependencies.
- Before opening a PR, run: `npm run build && npm test`.

## Commit & Pull Request Guidelines
- Existing history uses short, lowercase, imperative summaries (example: `added tool-selection`).
- Keep commit subjects concise and scoped to one logical change.
- PRs should include:
  - what changed and why,
  - impacted modules/paths,
  - test evidence (`npm test` output summary),
  - screenshots/log samples for protocol or UX-visible changes.

## Security & Configuration Tips
- Never commit secrets; `.env` is ignored.
- Respect tool guardrails in `context/tool-access.json`.
- Do not commit generated artifacts (`dist/`, `data/`, logs, temp files).
