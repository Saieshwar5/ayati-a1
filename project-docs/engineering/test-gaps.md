# Test Gaps To Watch

Areas that deserve careful test coverage when changed:

- IVec decision-action-reducer runner behavior.
- Context pack, git context task resolution, pending-turn routing, task asset
  persistence, and attachment restore behavior.
- Clarification follow-up resolution after `pendingTurn.routingStatus =
  "clarifying"`.
- Broader engine/app live-flow coverage around unusual create/activate routing
  failures beyond the covered session-run read-only and read-then-mutate
  promotion paths.
- Attachment preservation while a turn is still unbound or clarifying.
- App-level task-run finalization for completed, failed, blocked,
  needs-user-input, stuck/max-iteration, and tool-failure outcomes.
- System-event parity with chat pending-turn routing edge cases and failure
  handling.
- Daemon lifecycle and long-running service assumptions.
- Tool call validation and execution.
- Session rotation and memory persistence.
- Personal memory consolidation.
- Episodic indexing and retrieval.
- Document preparation and retrieval.
- File upload and artifact serving.
- WebSocket and CLI message contracts.
- Future multi-client/channel behavior.
- Plugin event normalization and system-event policy.
- Provider adapter response formatting.

When a change touches cross-module behavior, run more than the single local test file.
