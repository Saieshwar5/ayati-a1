# Debugging

Start with:

```bash
git status --short
pnpm --filter ayati-context-engine build
pnpm --filter ayati-main build
pnpm --filter ayati-context-engine test
pnpm --filter ayati-main test
```

Key owners:

- daemon/bootstrap: `ayati-main/src/app/main.ts`
- chat/system turns: `ayati-main/src/app/chat-turn-runtime.ts` and
  `system-event-runtime.ts`
- harness: `ayati-main/src/ivec/agent-runner/`
- resource scopes: `ayati-main/src/app/resource-scoped-tool-executor.ts`
- Context Engine host/runtime: `ayati-context-engine/src/runtime.ts` and
  `ayati-main/src/app/context-engine-runtime.ts`
- service: `ayati-context-engine/src/services/sqlite-context-engine-service.ts`
- workstreams/resources: `ayati-context-engine/src/workstreams/`, `src/resources/`,
  and their focused services
- WebSocket/HTTP: `ayati-main/src/server/`

For continuity failures, capture a live evaluation and inspect its correlated
run report, SQLite run/binding/resource rows, explicit request decision,
resource locator/version, context repository status and HEAD, and finalization
journal. Never repair by placing deliverables in the context repository or
editing runtime-owned records by hand.

Use `pnpm eval:agent -- inspect --evaluation <id> --latest` for the latest
evidence-linked lifecycle report. `pnpm feedback:context-engine` is a
compatibility alias for the unified latest report. Keep the daemon stopped
before archive/reset, catalog rebuild, or direct database inspection that
requires a consistent snapshot.
