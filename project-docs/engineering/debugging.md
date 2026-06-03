# Debugging

Start with:

```bash
git status --short
pnpm --filter ayati-main build
pnpm --filter ayati-main test
```

Useful places to inspect:

- Daemon startup: `ayati-main/src/app/main.ts`
- WebSocket transport: `ayati-main/src/server/ws-server.ts`
- HTTP API: `ayati-main/src/server/upload-server.ts`
- Agent message handling: `ayati-main/src/ivec/index.ts`
- Agent loop: `ayati-main/src/ivec/agent-loop.ts`
- Tool executor: `ayati-main/src/skills/tool-executor.ts`
- CLI message flow: `ayati-cli/src/app/app.tsx`

If behavior is provider-specific, inspect the adapter under `ayati-main/src/providers`.

If behavior is channel-specific, inspect the client/transport first, then verify the daemon payload path.

If behavior affects memory, tools, providers, events, or personalization, debug from the daemon side first.
