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

Git Context service:

```bash
pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context start
pnpm --filter ayati-git-context dev
pnpm --filter ayati-git-context test
```

Normal local use starts Git Context through `ayati-main`; the standalone
commands are mainly for focused service development and debugging.

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
