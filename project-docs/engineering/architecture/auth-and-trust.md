# Auth And Trust

Ayati is currently local-first. There is no full user-account authentication system in the codebase.

The daemon should be treated as highly privileged. It can hold user memory, access local files, execute tools, and act through integrations. That power is useful only when the daemon is controlled by the trusted user.

Current trust boundaries:

- CLI and Electron desktop clients connect to the local WebSocket server on
  loopback port 8080.
- The Electron renderer is sandboxed and reaches the daemon only through a
  narrow, sender-validated preload/main-process boundary. Plaintext desktop
  WebSocket configuration is rejected for non-loopback hosts.
- HTTP upload/artifact API runs on `127.0.0.1:8081` by default.
- Provider and integration credentials are read from environment variables.
- Context Engine runs inside the trusted daemon. Its typed service boundary,
  exact resource validation, and strict filesystem boundaries remain required.
- Core filesystem observation tools can read any canonical machine path allowed
  to the operating-system account running Ayati. A bound resource is not
  required for those reads.
- Filesystem effects remain workspace-only by default. A bound resource's
  canonical locator and mutate access are additional mutation requirements,
  not permission to escape `<AYATI_ROOT_DIR>/workspace/`.

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
symlinks before verifying that mutation remains inside both the configured
workspace and an exact mutable resource. User attachments enter immutable managed storage and are never
trusted for automatic context-Git commit.

Machine-wide read access is a high-trust temporary policy. A readable file's
contents may be included in a model request to the configured provider and
stored in the current run journal. Full feedback payloads and prompt tracing
may also contain those contents. Linux ownership and mode checks still apply;
Ayati does not elevate privileges or bypass operating-system permissions.
Operators must use a trusted model provider, keep tracing disabled unless
deliberately debugging, and run the daemon under an account whose readable
files are appropriate for agent access.

The workspace policy is a hard runtime boundary for Ayati's focused
filesystem mutation tools. Process and Python tools are authorized from their
declared working directory and effect targets; this declaration check is not
an operating-system sandbox for arbitrary native or Python code. Deployments
that require host-enforced containment must also isolate or disable those
general-purpose execution tools.

Before exposing the daemon beyond local development, review transport auth,
CORS, webhook validation, tool policy, filesystem boundaries, model-provider
data handling, memory privacy, artifact access, and secret handling.

Future remote clients must not get implicit full access just because they can reach a daemon port. They need authentication, authorization, channel identity, and permission checks appropriate to the action.
