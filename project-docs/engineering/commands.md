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
pnpm context:archive-reset
pnpm context:archive-reset -- --confirm
pnpm context:catalog-rebuild
pnpm context:catalog-rebuild -- --confirm
```

Both mutation commands refuse a live Context Engine writer. Archive reset
preserves `<AYATI_ROOT_DIR>/workspace/`. Catalog rebuild requires an empty V5
catalog; after an archive reset, start and stop Ayati once before confirming
rebuild.

Live daemon evaluation:

```bash
pnpm eval:agent -- live --name <name> [--watch] [--capture full|safe]
pnpm eval:agent -- inspect --evaluation <id> [--run <run-id>|--latest]
pnpm eval:agent -- annotate --evaluation <id> [--run <run-id>]
pnpm eval:agent -- report --evaluation <id>
pnpm eval:agent -- compare --baseline <id> --candidate <id>
pnpm eval:agent -- prune [--older-than <days>|--keep <count>] [--confirm]
```

`dev:main:feedback`, `start:main:feedback`, and `feedback:context-engine` are
compatibility aliases into this same recorder and report surface.

Backend runtime performance benchmark:

```bash
pnpm --filter ayati-main bench:runtime
pnpm --filter ayati-main bench:runtime -- --scale=smoke
pnpm --filter ayati-main bench:runtime -- --scale=stress
pnpm --filter ayati-main bench:runtime -- --list
pnpm --filter ayati-main bench:runtime -- --case focus_store --scale=standard
pnpm --filter ayati-main bench:runtime -- --output=data/benchmarks/runtime-debug --scale=smoke
```

CLI:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli start
pnpm --filter ayati-cli dev
pnpm --filter ayati-cli test
```
