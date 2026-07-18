# Environments

Current documented environment is local development with a long-running local daemon.

Default services:

- Backend WebSocket server: `localhost:8080`.
- Backend HTTP upload/artifact/Pulse API: `127.0.0.1:8081`.
- Managed local Git Context server: versioned HTTP/JSON over a Unix socket.
- CLI client connects to `ws://localhost:8080`.

Runtime data:

- Stored under `ayati-main/data/`.
- Git Context task/session repositories also live under the configured data
  root, defaulting to `ayati-main/work_space/.ayati-context/`.
- Should not be committed.

Daemon operation concerns:

- The daemon may run for long periods and should preserve runtime state.
- Future service installation should define restart behavior.
- Logs should be available for debugging long-running behavior.
- Runtime data should have backup/retention guidance before serious use.
- Until catalog rebuild is complete, backups must include both Git Context
  SQLite and the session/task repositories.
- Remote access should be disabled or strongly protected until auth and permissions are designed.

Production or shared deployment is not fully documented yet. Before deploying outside local development, define:

- Transport authentication.
- CORS policy.
- Secret management.
- Filesystem and tool boundaries.
- Upload limits.
- Plugin webhook validation.
- Runtime data backup and retention.
- Provider rate-limit behavior.
