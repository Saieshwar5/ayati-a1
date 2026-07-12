# Ayati Git Context Engine

Independent local context persistence service for Ayati.

Current implementation status:

- Typed transport-neutral service contracts.
- Structured error contracts.
- HTTP/JSON server with Unix-socket and TCP support.
- Typed client.
- File-backed built-in SQLite operational journal.
- Idempotent active-session, conversation, run, and run-step operations.
- Restart-safe active-context reconstruction.

Git session repositories, Markdown conversation files, task repositories, and
Ayati runtime integration are intentionally deferred to later verified
migration slices.

Build and test:

    pnpm --filter ayati-git-context build
    pnpm --filter ayati-git-context test

Run the current contract-only service:

    pnpm --filter ayati-git-context build
    pnpm --filter ayati-git-context start

The default socket is:

    /tmp/ayati-git-context.sock

Override it with AYATI_GIT_CONTEXT_SOCKET.

The default data root is:

    data/git-context-engine

Override it with AYATI_GIT_CONTEXT_DATA_DIR.
