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
directory. Activating an existing task requires an explicit decision to continue its
current request or create a new request. A mutating run commits verified task
files and compact context exactly once at finalization.

The service also provides:

- typed HTTP/JSON contracts and client;
- SQLite lifecycle, idempotency, locks, and recovery journals;
- atomic run preparation and immutable optional task/request binding;
- ignored attachment inboxes with tracked provenance manifests;
- context-only commits for verified external outcomes;
- direct single-repository task mutation and finalization.

Build and test:

```sh
pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context test
```

The managed daemon normally uses `ayati-main/data/context-engine/context.sqlite`
and `ayati-main/work_space/.ayati-context`. Direct standalone launches use the
package-local defaults in `src/server-main.ts`. All paths can be overridden by
the Git Context environment variables documented under `project-docs/`.
