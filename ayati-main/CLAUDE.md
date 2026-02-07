# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Ayati

Ayati is an AI agent server built on a plugin-based architecture. It uses an `AgentEngine` as the core runtime and a dynamic plugin system where plugins are loaded, registered, started, and stopped through a lifecycle-managed registry.

## Commands

- **Build:** `npm run build` (runs `tsc`, outputs to `dist/`)
- **Start:** `npm run start` (runs `node dist/index.js`)
- **Dev:** `npm run dev` (uses nodemon — watches `src/` for `.ts` changes, then compiles and runs automatically)
- **Run all tests:** `npm run test` (runs `vitest run`)
- **Run single test file:** `npx vitest run tests/core/registry.test.ts`
- **Watch tests:** `npm run test:watch`

## Architecture

The project is a TypeScript ESM (`"type": "module"`) Node.js application. All internal imports use `.js` extensions (required by NodeNext module resolution).

### Layers

- **`src/index.ts`** — Entrypoint. Calls `main()` from app layer.
- **`src/app/main.ts`** — Bootstrap. Creates `AgentEngine`, `WsServer`, and `PluginRegistry`. Start order: engine → server → plugins. Stop order: plugins → server → engine. Handles graceful shutdown (SIGINT/SIGTERM).
- **`src/server/`** — `WsServer` class. WebSocket daemon server that accepts client connections and forwards messages to the engine. Auto-restarts with exponential backoff (1s initial, 30s max, 10 retries) on failure. Data flow: `Client → WsServer → AgentEngine`.
- **`src/engine/`** — `AgentEngine` class. The core agent runtime (currently a stub). Receives messages via `handleMessage(clientId, data)`.
- **`src/core/`** — Plugin system. Exports: `AyatiPlugin` (interface), `PluginRegistry` (class), `loadPlugins` (function), `PluginFactory` (type).
- **`src/config/plugins.ts`** — Central plugin registration. Add `PluginFactory` entries (dynamic `import()` calls) to the array to enable plugins.
- **`src/plugins/`** — Plugin implementations. Each plugin is a directory with an `index.ts` (default-exporting an `AyatiPlugin`) and a `plugin.json` metadata file. See `_template/` for the pattern.
- **`src/shared/`** — Shared utilities (e.g., `createId()`).

### Plugin Contract

Every plugin must implement the `AyatiPlugin` interface:

```typescript
interface AyatiPlugin {
  name: string;
  version: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
```

Plugins are default-exported and loaded via async factory functions (`PluginFactory`). The registry stops plugins in reverse registration order during shutdown.

### Adding a New Plugin

1. Copy `src/plugins/_template/` to `src/plugins/<name>/`
2. Implement the `AyatiPlugin` interface in `index.ts`
3. Register it in `src/config/plugins.ts`: `() => import("../plugins/<name>/index.js")`

### Tests

Tests live in `tests/` mirroring the `src/` structure. Uses Vitest with the `describe`/`it`/`expect` pattern. Tests import directly from `src/` (not `dist/`).

## Logging

- **Never use raw `console.log`** for debug output. Use the color-coded helpers from `src/shared/debug-log.ts`:
  - `devLog(...)` — cyan `INFO` label for general tracing
  - `devWarn(...)` — yellow `WARN` label for suspicious states
  - `devError(...)` — red `ERROR` label for caught failures
- All debug logs print a bright magenta `[DEBUG]` prefix so they stand out in the terminal.
- Import from shared: `import { devLog, devWarn, devError } from "../shared/index.js";`
- To find all debug logs before a production build: `grep -rn "devLog\|devWarn\|devError" src/`
- Remove every `devLog` / `devWarn` / `devError` call before production. They exist only for development tracking.

## Coding Style

- Keep it simple and readable. Write code that a human can understand at a glance.
- No file should exceed 300 lines. If it does, split it into smaller focused modules.
- Always run tests (`npm run test`) after implementing a feature to verify nothing is broken.

## TypeScript Config

- `strict: true` with `noUncheckedIndexedAccess: true` — indexed access returns `T | undefined`
- Target: `esnext`, Module: `nodenext`
- Source maps and declarations enabled
