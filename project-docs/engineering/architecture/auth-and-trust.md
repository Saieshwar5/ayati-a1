# Auth And Trust

Ayati is currently local-first. There is no full user-account authentication system in the codebase.

The daemon should be treated as highly privileged. It can hold user memory, access local files, execute tools, and act through integrations. That power is useful only when the daemon is controlled by the trusted user.

Current trust boundaries:

- CLI connects to local WebSocket server on `localhost:8080`.
- HTTP upload/artifact/Pulse API runs on `127.0.0.1:8081` by default.
- `AYATI_HTTP_API_TOKEN` can protect Pulse API access.
- Provider and integration credentials are read from environment variables.
- Git Context uses a local Unix socket. Local transport does not remove the
  need for typed request validation and strict filesystem boundaries.
- A selected task's canonical working directory is the default authorization
  root for task-scoped mutation tools.

Security-sensitive capabilities:

- Shell execution.
- Filesystem read/write.
- Python execution.
- SQLite database operations.
- Memory read/write and personalization data.
- File uploads and artifact serving.
- Webhook/event integrations.
- Git repository and `.ayati/` lifecycle mutation.

The model may discover, inspect, and select a task/request through typed Git
Context tools, but the runtime owns registration, task creation, request
allocation, lifecycle-file writes, and Git commits. Requested directories must
be below configured trust roots and pass clean-Git or explicit-baseline policy.
Path checks resolve symlinks before verifying that mutation remains inside the
selected task root. User attachments enter managed storage or ignored inbox
staging first; they are not trusted for automatic Git commit.

Before exposing the daemon beyond local development, review transport auth, CORS, webhook validation, tool policy, filesystem boundaries, memory privacy, artifact access, and secret handling.

Future remote clients must not get implicit full access just because they can reach a daemon port. They need authentication, authorization, channel identity, and permission checks appropriate to the action.
