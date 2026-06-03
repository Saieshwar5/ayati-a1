# CLI UI

The CLI app supports a terminal-first chat workflow.

Expected UI behavior:

- Header at the top.
- Scrollable message list.
- Status bar showing connection/loading/attachment state.
- Chat input at the bottom.
- Mouse scroll support for the message list.

Current slash commands:

- `/attach <local-file-path>`
- `/attach <local-file-path> -- <message>`
- `/files`
- `/clearfiles`

When changing CLI behavior, update tests near:

- `ayati-cli/src/app/app.test.tsx`
- `ayati-cli/src/app/commands.test.ts`
- `ayati-cli/src/app/components/*.test.ts`
- `ayati-cli/src/app/input/*.test.ts`
