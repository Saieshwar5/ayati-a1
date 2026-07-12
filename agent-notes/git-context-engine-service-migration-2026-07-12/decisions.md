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

## Open Implementation Choices

These choices do not change the main architecture but must be resolved during
the relevant implementation slice:

- Whether the independent service is a new monorepo package or an isolated
  backend module launched as a child process.
- Exact Unix socket and development HTTP configuration.
- Exact SQLite migration library.
- Safety-checkpoint age and size thresholds.
- Retention period for read-only session-run tool journals.
- Whether semantic summary improvement is enabled initially.
- Whether durable task collections use symlinks or small task-reference files.
- Exact task repository URL format for portable relative submodules.
- Whether canonical local task repositories are always bare.
- How an existing user-owned external Git repository is adopted without
  changing its remotes or policies.
- Exact naming convention for conversation files after multiple runs target
  the same task.
- Whether task mutation checkpoints happen after every verified mutating tool
  or after a deterministic semantic batch.

Open choices must be resolved with focused evidence. They must not weaken the
locked invariants.

