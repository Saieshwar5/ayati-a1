# Local Setup

Prerequisites:

- Node.js 20+.
- pnpm.

Install:

```bash
pnpm install
```

Configure local environment:

- Put provider keys and optional integration credentials in `.env`.
- The backend start script currently uses `node --env-file=../.env dist/index.js` from `ayati-main`.

Start the daemon:

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main start
```

Start CLI in another terminal:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli start
```

Mental model:

- `ayati-main` is the app's persistent agent daemon.
- `ayati-main` starts and supervises the local `ayati-git-context` service by
  default; users do not need to start it separately.
- Durable context is stored in independent `W-*` repositories under
  `<AYATI_ROOT_DIR>/workstreams/`; real outputs stay in `workspace/` or the
  user-selected resource path.
- `ayati-cli` is one communication client.
- Stop or restart the CLI without assuming the daemon state is gone.
- Stop or restart a session without assuming durable work is closed;
  workstreams reopen from context and explicit request selection.
