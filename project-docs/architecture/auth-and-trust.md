# Auth And Trust

Ayati is currently local-first. There is no full user-account authentication system in the codebase.

The daemon should be treated as highly privileged. It can hold user memory, access local files, execute tools, and act through integrations. That power is useful only when the daemon is controlled by the trusted user.

Current trust boundaries:

- CLI connects to local WebSocket server on `localhost:8080`.
- HTTP upload/artifact/Pulse API runs on `127.0.0.1:8081` by default.
- `AYATI_HTTP_API_TOKEN` can protect Pulse API access.
- Telegram access can be restricted with `AYATI_TELEGRAM_ALLOWED_CHAT_ID`.
- Provider and integration credentials are read from environment variables.
- External skills are controlled by `context/skill-policy.json` and `context/skill-secrets.json`.

Security-sensitive capabilities:

- Shell execution.
- Filesystem read/write.
- Python execution.
- SQLite database operations.
- Memory read/write and personalization data.
- File uploads and artifact serving.
- External skill activation.
- Webhook/event integrations.

Before exposing the daemon beyond local development, review transport auth, CORS, webhook validation, tool policy, skill policy, filesystem boundaries, memory privacy, artifact access, and secret handling.

Future remote clients must not get implicit full access just because they can reach a daemon port. They need authentication, authorization, channel identity, and permission checks appropriate to the action.
