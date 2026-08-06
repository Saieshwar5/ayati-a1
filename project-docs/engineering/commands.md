# Commands

Run from repository root unless noted.

Install:

```bash
pnpm install
```

Build all packages:

```bash
pnpm build
```

Run all tests:

```bash
pnpm test
```

Backend:

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main start
pnpm --filter ayati-main dev
pnpm --filter ayati-main test
```

Context Engine package:

```bash
pnpm --filter ayati-context-engine build
pnpm --filter ayati-context-engine test
```

The engine is a library opened in-process by `ayati-main`; it has no standalone
server command.

Context Engine clean reset and catalog recovery are preview-first:

```bash
pnpm context:workstream-migrate
pnpm context:workstream-migrate -- --confirm
pnpm context:archive-reset
pnpm context:archive-reset -- --confirm
pnpm context:catalog-rebuild
pnpm context:catalog-rebuild -- --confirm
```

All mutation commands require a stopped Context Engine writer. Workstream
migration converts clean nested repositories into the one shared repository,
archives the sources and prior database, and installs a rebuilt V12 catalog.
Archive reset preserves `<AYATI_ROOT_DIR>/workspace/`. Catalog rebuild
requires an empty V12 catalog; after an archive reset, start and stop Ayati once
before confirming rebuild.

Live daemon evaluation:

```bash
pnpm eval:agent -- live --name <name> [--watch] [--capture full|safe]
pnpm eval:agent -- inspect --evaluation <id> [--run <run-id>|--latest]
pnpm eval:agent -- annotate --evaluation <id> [--run <run-id>]
pnpm eval:agent -- report --evaluation <id>
pnpm eval:agent -- compare --baseline <id> --candidate <id>
pnpm eval:agent -- prune [--older-than <days>|--keep <count>] [--confirm]
```

CLI:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli start
pnpm --filter ayati-cli dev
pnpm --filter ayati-cli test
```

Electron desktop client (Node.js 22.12+):

```bash
pnpm --filter ayati-desktop build
pnpm --filter ayati-desktop start
pnpm --filter ayati-desktop dev
pnpm --filter ayati-desktop test
```

The daemon must already be running. `start` launches the last built desktop
bundle; `dev` rebuilds it before launch. From the repository root, the matching
shortcuts are `pnpm start:desktop` and `pnpm dev:desktop`.

Voice control (after building the CLI):

```bash
node ayati-cli/dist/index.js voice status
node ayati-cli/dist/index.js voice press
node ayati-cli/dist/index.js voice release
node ayati-cli/dist/index.js voice send
node ayati-cli/dist/index.js voice cancel
```

The daemon must be running. Push-to-talk desktop bindings should call `press`
on key-down and `release` on key-up.
