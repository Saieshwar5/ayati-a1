# Target Architecture

## Process Boundary

The Git Context Engine runs as an independent local service:

    agent harness
      -> typed Git Context Engine client
      -> local HTTP/JSON API over a Unix socket
      -> Git Context Engine server
      -> Git repositories and SQLite

The service should normally bind to a Unix domain socket. A loopback HTTP port
with an authentication token can be supported for development and platforms
where a socket is unsuitable.

MCP is an optional model-facing adapter, not the deterministic lifecycle
transport.

## Responsibility Split

### Agent harness

- Builds decisions.
- Selects and executes tools.
- Maintains run-local WorkState.
- Performs deterministic tool verification through existing contracts.
- Decides when task completion should be attempted.
- Requests context-engine lifecycle operations through a client.

### Git Context Engine

- Owns all Git and context-database writes.
- Creates and seals sessions.
- Persists conversation segments.
- Allocates and journals runs.
- Creates and finds task repositories.
- Mounts task repositories as session submodules.
- Commits verified task checkpoints.
- Finalizes cross-repository runs.
- Reconciles interrupted transactions.
- Builds context projections.
- Maintains task search and virtual-view indexes.

### Model-facing MCP tools

Allowed examples:

    task_search
    task_read
    task_list_files
    task_log
    task_activate_for_turn
    task_create_for_turn
    session_read_recent

Forbidden examples:

    commit_task
    commit_session
    update_gitlink
    seal_session
    recover_transaction
    edit_database_state

The model may express routing intent. The harness and service own mutation and
commit mechanics.

## Source Of Truth

### Git is canonical for

- Committed session conversation.
- Session commit history.
- Task repository files.
- Task commit history.
- Task validation and outcome trailers.
- Session gitlinks to exact task states.
- Completed task-run evidence committed in the session.

### SQLite is authoritative for unfinished operations

- Active session identity and rollover state.
- Active conversation segments before Git commit.
- Active run and step journal.
- Pending cross-repository finalization phase.
- Task mutation locks.
- Queued messages during rollover.

### SQLite is a rebuildable cache for

- Session summary projection.
- Task summary projection.
- Task search index.
- Recent and frequent task views.
- Commit metadata index.
- File-tree index.
- Context-pack cache.

Completed task history must remain usable if the rebuildable SQLite tables are
deleted and reconstructed.

## Repository Locations

Recommended root:

    data/context-engine/

Layout:

    data/context-engine/
      context.db
      engine.sock
      tasks/
        W-20260712-0001-coffee-shop.git/
        W-20260712-0002-agent-memory.git/
      sessions/
        S-20260712-local/
        S-20260713-local/
      task-catalog/
      smart-views/

Canonical task repositories may be bare. Active session submodules are normal
working checkouts containing real files.

## Session Repository Shape

    S-20260712-local/
      .git/
      .gitmodules
      session/
        meta.json
      conversations/
        000001-session.md
        000002-task-W-20260712-0001.md
      runs/
        R-20260712-0002/
          run.json
          steps.jsonl
      attachments/
      tasks/
        W-20260712-0001/

The tasks directory contains gitlinks and active submodule checkouts. It does
not contain copied task repositories.

### Session metadata

Keep session/meta.json small:

    {
      "sessionId": "S-20260712-local",
      "date": "2026-07-12",
      "timezone": "Asia/Kolkata",
      "agentId": "local",
      "createdAt": "2026-07-12T00:00:00+05:30"
    }

Do not store active task, current progress, task facts, or a mutable session
summary in this file.

## Task Repository Shape

A task repository contains actual task files:

    .gitignore
    package.json
    src/
    tests/
    README.md
    .ayati/
      task.md

The project files vary by task. A one-file task may contain only one user
deliverable plus the small Ayati descriptor.

Do not generate these as canonical task memory:

    state.json
    notes.md
    assets.json
    task-summary.json
    tool-facts.jsonl

### Small task descriptor

Use .ayati/task.md instead of a mandatory root AGENTS.md.

Reason:

- AGENTS.md may already be owned by the user or project.
- Many coding agents interpret AGENTS.md as instructions.
- The engine must not overwrite user instructions.
- A hidden Ayati namespace clearly owns the portable descriptor.

Suggested content:

    # Coffee-shop Website

    Task: W-20260712-0001

    Responsive coffee-shop website with menu, contact, and reservation
    capabilities.

    ## Important Paths

    - index.html: main page
    - app.js: client behavior
    - styles.css: visual design

    ## Current Snapshot

    Reservation form and deterministic JavaScript validation are complete.

Rules:

- Keep the file short.
- Update it only after successful task-run finalization.
- Never include raw tool facts or full history.
- Never claim validation that did not run.
- Treat it as a portable descriptor, not a database-like task state.

## SQLite Schema Direction

### sessions

    session_id
    date
    timezone
    repo_path
    head_sha
    status
    previous_session_id
    created_at
    sealed_at

### conversation_segments

    conversation_id
    session_id
    sequence
    file_path
    task_id nullable
    run_id
    status
    content_hash
    committed_sha nullable
    started_at
    closed_at

### messages

    message_id
    conversation_id
    sequence
    role
    content
    created_at
    file_offset nullable

This table supports fast active-context reads. The committed Markdown remains
canonical after finalization.

### runs

    run_id
    session_id
    task_id nullable
    run_class
    status
    started_at
    completed_at
    task_before nullable
    task_after nullable
    conversation_id

### run_steps

    run_id
    step
    purpose
    tool
    bounded_input
    bounded_output
    output_hash
    verification
    work_state
    created_at

### tasks

    task_id
    repository_path
    durable_branch
    head_sha
    title_cache
    summary_cache
    latest_outcome_cache
    updated_at

The Git repository remains canonical. This row is an indexed locator.

### task_usage

    task_id
    session_id
    run_id
    used_at
    mutation_count

### task_locks

    task_id
    owner_session_id
    owner_run_id
    acquired_at
    expires_at

### pending_transactions

    transaction_id
    run_id
    phase
    session_head_before
    task_head_before
    task_head_after nullable
    conversation_id
    conversation_hash
    updated_at

### caches and organization

    summary_cache
    task_search_index
    task_collections
    service_events

Use WAL mode, foreign keys, explicit transactions, and one serialized lifecycle
writer.

## Deterministic API

Initial local API surface:

    POST /sessions/ensure-active
    POST /sessions/rollover
    POST /conversations/append
    POST /runs/start
    POST /runs/{runId}/steps
    POST /runs/{runId}/promote
    POST /tasks/search
    POST /tasks
    POST /tasks/{taskId}/activate
    GET  /tasks/{taskId}/context
    POST /runs/{runId}/complete
    POST /runs/{runId}/finalize
    GET  /context/active
    POST /recovery/reconcile

Every write request carries:

    requestId
    expectedHead when applicable
    sessionId
    runId when applicable

Retries with the same requestId must return the previously completed result
instead of performing the mutation twice.

## Active Context Projection

The harness should request one primary object:

    GET /context/active

It should provide:

- Current session identity and head.
- Derived session summary.
- Pending uncommitted conversation.
- Previous-session carryover when applicable.
- Active task identity, checkout, commit, compact descriptor, recent commits,
  important paths, and validation.
- Current run ID, class, WorkState projection, and recent tool context.
- Pending degraded writes or recovery warnings.

The projection is cached but always traceable to:

    session HEAD
    task HEAD
    pending conversation digest
    active run revision

## Search And Virtual Directories

Task repositories have one canonical location. Organizational directories are
views, not ownership:

    task-catalog/collections/
      starred/
      by-type/coding/
      by-type/documents/
      by-topic/ai-agents/
      custom/

    smart-views/
      recent/
      frequent/
      active/
      blocked/

Durable user collections may be stored as validated task references or
symlinks under a small catalog repository. Smart views are generated from
SQLite and Git history and are not committed on every access.

Search authority order:

1. Explicit task ID or user selection.
2. Exact canonical repository or resource identity.
3. Exact Git path ownership and history.
4. Current task continuation evidence.
5. Branch/repository title and commit messages.
6. File-tree names.
7. User collections, recency, and frequency.
8. Semantic ranking as a fallback.

Category membership helps discovery. It never authorizes mutation.

## Security And Concurrency

- The service is the only writer.
- Mutation requires an active task lock.
- First release permits one mutating session per task.
- Read-only task inspection may be concurrent.
- The service resolves real paths through symlinks.
- External paths require explicit user authority.
- Secrets must be checked before task commits.
- Build outputs and dependencies must be ignored.
- No normal operation force-checks out, force-pushes, or rewrites task history.
- The service fails closed for mutation when persistence is unavailable.

