# Decisions And Open Questions

## Locked Direction

### Independent service

Git context becomes an independent local server. Ayati communicates through a
typed client.

### Git plus SQLite

Git owns completed durable history. SQLite owns live operational state and
rebuildable indexes.

### Session main repository

Conversation, task-run evidence, attachments, and task gitlinks live directly
in the daily session repository. New sessions do not put conversation in a
session-store submodule.

### Independent task repositories

Every durable task is an independent repository from creation. It is mounted
as a submodule in every session that uses it.

### One submodule per touched task

A session that touches twenty tasks may contain twenty task submodules. This
lets one session commit record all twenty exact task states simultaneously.

### Real files

The agent works on normal checked-out files. It never directly edits internal
.git files.

### Task state

The task repository HEAD and Git tree are canonical task state. No new
database-like task state.json is generated.

### Portable descriptor

Use .ayati/task.md as a small portable descriptor and index aid. Do not require
or overwrite root AGENTS.md.

### Run placement

Detailed task-run evidence lives in the session repository. Direct harmless
session runs do not require separate Git run files.

### Conversation files

Use multiple bounded conversation segments. Persist every append to SQLite and
the working Markdown file before acknowledgement.

### Session commits

Normal commits happen for task-run finalization, safety checkpoints when
needed, and mandatory session seal. Do not commit every harmless response.

### Summary

Session summary is a derived SQLite cache, not a canonical file. Exact
conversation remains authoritative.

### Midnight

Midnight marks rollover pending. Active work finishes and commits before the
old session seals. New messages wait for the new session.

### Carryover

The previous sealed-session summary is prominent in a new session until the
new session creates its first commit.

### Task routing

Exact task and resource ownership outrank semantic similarity. Unresolved
mutation never defaults to the active task.

### MCP

MCP is optional and agent-facing. Deterministic commit, finalization, rollover,
and recovery operations use the internal API.

### Legacy storage

Historical repositories remain read-only. Migration creates new task
repositories without rewriting or deleting the originals.

## Important Qualifications

### Session-only conversation is not committed immediately

It is still durable because it is journaled in SQLite and flushed to a working
file. It becomes Git history at a later task commit, safety checkpoint, or
session seal.

### Symbolic links do not version targets

Use a normal task checkout or Git worktree for user-specified external
locations when actual contents must be tracked. A symlink is navigation only.

### Session points down, task links logically back

The session stores a native gitlink to the task commit. The task records
session, run, conversation ID, and conversation hash in trailers.

### Closed session checkout may be removed

Only after the task commit is present in the canonical task repository and the
session gitlink is committed.

## Resolved During Implementation

- The independent service is a top-level pnpm workspace package named
  ayati-git-context.
- The first transport is dependency-free HTTP/JSON using Node HTTP.
- Unix domain sockets are the primary local transport.
- TCP is supported for tests and development.
- The executable reports degraded readiness until persistence is configured;
  it does not use a disposable in-memory production store.
- The operational database uses the Node built-in node:sqlite API, avoiding a
  native third-party dependency.
- SQLite runs in WAL mode with foreign keys, full synchronous durability, and
  a serialized service write queue.
- Incoming user and system-event messages create conversation segments;
  assistant messages append to the active segment.
- Only one run may be active per session in the first implementation.
- Session repositories are initialized directly on main with one deterministic
  identity commit; harmless conversation appends remain durable but uncommitted.
- SQLite-to-Markdown synchronization uses a durable outbox and recoverable
  idempotency states instead of pretending SQLite and the filesystem share a
  transaction.
- Active context carries exact pending messages and a digest; its cache key also
  includes session HEAD and active-run tool-step revision.
- Canonical task repositories are bare repositories under tasks/. A temporary
  deterministic checkout creates the initial real files and commit; later
  session submodules will provide normal mutable working checkouts.
- The first task commit contains `.ayati/task.md`. The descriptor has a stable
  `Task:` identity line but may evolve after later successful task runs.
- SQLite task rows are operational catalog locators. The task Git branch and
  tree remain the durable task-state authority.
- Session task checkouts are lazy submodules at tasks/<task-id>. Canonical task
  repositories remain bare and session checkouts stay on attached main.
- `.gitmodules` stores a portable path relative from the session repository to
  the sibling canonical tasks directory. Runtime cloning enables Git's local
  file transport only for the individual lifecycle command.
- Mounting stages `.gitmodules` and the exact task gitlink but does not create a
  session commit. Task-run finalization or session sealing owns that commit.
- SQLite session_task_mounts records operational mount and recovery state; the
  session Git index and task repository remain the exact content authorities.

## Open Implementation Choices

These choices do not change the main architecture but must be resolved during
the relevant implementation slice:

- Exact process supervision and startup relationship between ayati-main and
  the independent service.
- Production socket location and authentication policy for development TCP.
- Safety-checkpoint age and size thresholds.
- Retention period for read-only session-run tool journals.
- Whether semantic summary improvement is enabled initially.
- Whether durable task collections use symlinks or small task-reference files.
- How an existing user-owned external Git repository is adopted without
  changing its remotes or policies.
- Exact naming convention for conversation files after multiple runs target
  the same task.
- Whether task mutation checkpoints happen after every verified mutating tool
  or after a deterministic semantic batch.

Open choices must be resolved with focused evidence. They must not weaken the
locked invariants.
