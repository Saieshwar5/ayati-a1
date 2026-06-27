# Test Gaps To Watch

Areas that deserve careful test coverage when changed:

- IVec decision-action-reducer runner behavior.
- Context pack, git context task resolution, task asset persistence, and attachment restore behavior.
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
