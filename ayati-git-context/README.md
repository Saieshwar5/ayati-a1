# Ayati Git Context Engine

Independent local context persistence service for Ayati.

Current implementation status:

- Typed transport-neutral service contracts.
- Structured error contracts.
- HTTP/JSON server with Unix-socket and TCP support.
- Typed client.
- Contract-only executable health surface.

Git repositories, SQLite persistence, session lifecycle, task repositories,
and Ayati runtime integration are intentionally deferred to later verified
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
