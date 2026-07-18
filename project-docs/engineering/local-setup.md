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
- New durable work is stored in independent `T-*` task repositories under the
  configured Git Context data root.
- `ayati-cli` is one communication client.
- Stop or restart the CLI without assuming the daemon state is gone.
- Stop or restart a session without assuming a task is closed; tasks reopen
  from their repositories and explicit request selection.
