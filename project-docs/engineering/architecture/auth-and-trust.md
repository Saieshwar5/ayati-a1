# Auth And Trust

Ayati is currently local-first. There is no full user-account authentication system in the codebase.

The daemon should be treated as highly privileged. It can hold user memory, access local files, execute tools, and act through integrations. That power is useful only when the daemon is controlled by the trusted user.

Current trust boundaries:

- CLI connects to local WebSocket server on `localhost:8080`.
- HTTP upload/artifact/Pulse API runs on `127.0.0.1:8081` by default.
- `AYATI_HTTP_API_TOKEN` can protect Pulse API access.
- Provider and integration credentials are read from environment variables.
- Context Engine runs inside the trusted daemon. Its typed service boundary,
  exact resource validation, and strict filesystem boundaries remain required.
- A bound resource's canonical locator and access mode define the authorization
  boundary for resource-scoped tools.

Security-sensitive capabilities:

- Shell execution.
- Filesystem read/write.
- Python execution.
- SQLite database operations.
- Memory read/write and personalization data.
- File uploads and artifact serving.
- Webhook/event integrations.
- Resource mutation and Context Engine lifecycle mutation.

The model may discover, inspect, and select a workstream/request through typed
Context Engine controls, but runtime owns identity allocation, resource binding,
mutation journals, lifecycle files, and context commits. Path checks resolve
symlinks before verifying that mutation remains inside an exact mutable
resource. User attachments enter immutable managed storage and are never
trusted for automatic context-Git commit.

Before exposing the daemon beyond local development, review transport auth, CORS, webhook validation, tool policy, filesystem boundaries, memory privacy, artifact access, and secret handling.

Future remote clients must not get implicit full access just because they can reach a daemon port. They need authentication, authorization, channel identity, and permission checks appropriate to the action.
