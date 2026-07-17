# Ayati Git Context Engine

Independent local context persistence service for Ayati.

The default task model is repository V1:

```text
<workspace>/tasks/T-YYYYMMDD-NNNN-<slug>/
  .git/
  .ayati/task.md
  .ayati/requests/R-NNNN-<slug>.md
  .ayati/references.md
  .ayati/inbox/        # ignored input bytes
  task-owned files
```

Each task is one normal, non-bare Git repository and one stable working
directory. New task runs select `T-*` repositories without a session mount.
Activating an existing V1 task requires an explicit decision to continue its
current request or create a new request. A mutating run commits verified task
files and compact context exactly once at finalization.

The service also provides:

- typed HTTP/JSON contracts and client;
- SQLite lifecycle, idempotency, locks, and recovery journals;
- read-first session runs and task/request/run binding;
- ignored attachment inboxes with tracked provenance manifests;
- context-only commits for verified external outcomes;
- dry-run legacy migration inventory and one-commit migration for clean
  managed `W-*` tasks;
- read/write legacy adapters for tasks that are not yet safe to migrate.

Legacy bare repositories and historical session gitlinks are retained during
migration. V1 task execution never creates a bare mirror, clone, task
submodule, push, or session gitlink.

Build and test:

```sh
pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context test
```

The default socket is `/tmp/ayati-git-context.sock`; override it with
`AYATI_GIT_CONTEXT_SOCKET`. The default data root is
`data/git-context-engine`; override it with `AYATI_GIT_CONTEXT_DATA_DIR`.
