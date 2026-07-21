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

For continuity failures, inspect the feedback trace, SQLite run/binding/resource
rows, explicit request decision, resource locator/version, context repository
status and HEAD, and finalization journal. Never repair by placing deliverables
in the context repository or editing runtime-owned records by hand.

Use `pnpm feedback:context-engine` for the compact lifecycle report. Keep the
daemon stopped before archive/reset, catalog rebuild, or direct database
inspection that requires a consistent snapshot.
