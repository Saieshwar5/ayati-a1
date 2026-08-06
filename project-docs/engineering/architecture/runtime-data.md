# Runtime Data

Ayati uses one managed root:

```text
<AYATI_ROOT_DIR>/
  workspace/              preserved user-visible outputs
  workstreams/            one shared context-only Git repository
    .git/
    W-*/                   context directories, never nested repositories
  .ayati/
    context.db
    context.db-wal
    context.db-shm
    resources/
```

The daemon also keeps non-Git runtime data in its configured data directory,
including personal memory, provider settings, managed-file metadata and
derived extraction data, and Python scratch data. Live evaluation evidence is
isolated beneath `data/evaluations/`. Do not commit generated runtime state.

SQLite is authoritative for operational lifecycle and resource metadata.
`workstreams/` is one portable shared context history containing
`workstream.md`, `progress.md`, request files, and generated resource
projections. `workspace/` and user-selected external paths hold real
resources. Do not edit SQLite or the shared repository while Context Engine is
running.

## Live Evaluation Evidence

The supported passive evidence source is created by:

```bash
pnpm eval:agent -- live --name <name>
```

Schema-versioned sessions, append-only events, content-addressed sanitized
artifacts, model operations, provider requests, run evidence/findings, and
atomic Markdown/JSON reports live under
`ayati-main/data/evaluations/<evaluation-id>/`. Run
`pnpm eval:agent -- inspect --evaluation <id> --latest` after each terminal
turn or `pnpm eval:agent -- report --evaluation <id>` for the unified session
view, including Context Engine lifecycle evidence.

Agent event capture is active only for a live evaluation. Ordinary daemon runs
use a no-op event sink and do not create a second feedback trace or summary.
Evaluation writes and report generation remain queued; terminal checkpoints do
not hold the serialized chat turn, and explicit inspection or
daemon shutdown provides a deterministic drain boundary.

## Archive and Rebuild

`pnpm context:archive-reset` only prints resolved paths. With `--confirm`, it
archives the database including WAL/SHM, managed resources, and
workstreams into a timestamped sibling archive with a manifest. It preserves
`workspace/` and refuses broad paths or a live Context Engine writer.

For a pre-V9 root containing nested `W-*/.git` repositories, run:

```bash
pnpm context:workstream-migrate
pnpm context:workstream-migrate -- --confirm
```

Preview is read-only. Confirmation requires a stopped daemon, validates every
source repository, archives the old workstream root and database files,
creates a canonical empty `progress.md` when an older repository has no
ledger, creates one shared baseline commit, installs a V12 database, and
records recovery manifests.

`pnpm context:catalog-rebuild` scans the validated shared repository and
previews the reconstructible workstream/request/progress/resource catalog.
`--confirm` requires an empty initialized V12 database and a stopped daemon.
