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
- `ayati-cli` is one communication client.
- Stop or restart the CLI without assuming the daemon state is gone.
