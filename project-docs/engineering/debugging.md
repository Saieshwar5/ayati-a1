# Debugging

Start with:

```bash
git status --short
pnpm --filter ayati-main build
pnpm --filter ayati-main test
pnpm --filter ayati-git-context test
```

Useful places to inspect:

- Daemon startup: `ayati-main/src/app/main.ts`
- WebSocket transport: `ayati-main/src/server/ws-server.ts`
- HTTP API: `ayati-main/src/server/upload-server.ts`
- Agent message handling: `ayati-main/src/ivec/index.ts`
- Agent loop: `ayati-main/src/ivec/agent-loop.ts`
- Git Context process/client integration:
  `ayati-main/src/app/git-context-process.ts` and
  `ayati-main/src/app/git-context-runtime.ts`
- Git Context protocol/service: `ayati-git-context/src/server.ts` and
  `ayati-git-context/src/services/sqlite-git-context-service.ts`
- Tool executor: `ayati-main/src/skills/tool-executor.ts`
- CLI message flow: `ayati-cli/src/app/app.tsx`

If behavior is provider-specific, inspect the adapter under `ayati-main/src/providers`.

If behavior is channel-specific, inspect the client/transport first, then verify the daemon payload path.

If behavior affects memory, tools, providers, events, or personalization, debug from the daemon side first.

For task-continuity failures, inspect the feedback trace, context SQLite
lifecycle, selected task id/request decision, repository validation result,
working tree, and Git HEAD. Do not repair V1 by manually mounting it or editing
runtime-owned `.ayati/` files.
