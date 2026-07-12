# Independent Git Context Engine Migration

Created: 2026-07-12

Status: sixth implementation slice complete. The standalone service now owns
daily sessions, canonical tasks, lazy task submodules, and run-scoped checkout
mutation authority with Git-derived provenance. Verified task checkpoint
commits and Ayati runtime integration have not started.

Implementation branch:

    refactor/git-context-repository-migration

## Purpose

This plan captures the agreed direction for rebuilding Ayati's Git context
system around a simpler ownership model:

    session repository = conversation and durable run history
    task repository = actual evolving task files
    Git commits = completed durable history
    SQLite = live journal, cache, search index, locks, and recovery state
    Git Context Engine server = sole persistence owner

The context engine becomes an independent local service. The existing agent
harness remains:

    context pack
    -> decision
    -> action executor
    -> deterministic verification
    -> progress reducer

The migration changes context management and persistence. It must not
reintroduce controller stages or move decision-making out of the harness.

## Final Topology

Permanent task repositories:

    data/context-engine/tasks/
      W-20260712-0001-coffee-shop.git/
      W-20260712-0002-agent-memory.git/

Daily session repository:

    data/context-engine/sessions/S-20260712-local/
      session/meta.json
      conversations/
      runs/
      attachments/
      .gitmodules
      tasks/
        W-20260712-0001/   task repository submodule
        W-20260712-0002/   task repository submodule

Every task is created as an independent repository from its first durable
mutation. It is added to each active session that uses it as a submodule. It is
not converted from a session branch into a repository at session close.

## Files In This Plan

- problem.md: current problems, desired product model, goals, and non-goals.
- architecture.md: service boundary, Git/SQLite ownership, repository layouts,
  API and MCP surfaces, search catalog, and virtual directories.
- lifecycle.md: conversation, run, task, commit, rollover, summary, and recovery
  lifecycles.
- migration.md: implementation stages, code ownership, legacy migration, and
  cutover order.
- testing.md: deterministic, integration, failure-injection, migration,
  performance, and live-test acceptance coverage.
- decisions.md: locked decisions, important qualifications, and remaining open
  choices.
- conversation.md: chronological record of the user direction that produced
  this architecture.
- progress.md: execution checklist and future implementation log.

## Primary Invariants

Implementation agents must preserve these rules:

    Git Context Engine is the only Git and context-database writer.

    Git owns completed durable history.

    SQLite owns unfinished operational state and rebuildable indexes.

    Every provider-handled turn starts as a session run.

    Read-only work stays session-scoped.

    First durable mutation promotes the active run to a task run.

    Every durable task has one canonical independent repository.

    A session may mount many task repositories as submodules.

    A task may be used by many sessions without rewriting old sessions.

    Real task files are edited in a normal checkout, never by directly editing
    internal .git files.

    No mutation executes until task ownership is resolved deterministically.

    No unresolved mutation silently defaults to the active task.

    A read-only file is a reference, not an owned task resource.

    Every verified mutation is represented by task Git history.

    Every task-run session commit records the exact final task gitlink.

    Session-only conversation is persisted immediately even when it is not
    immediately committed.

    Midnight rollover never interrupts an active run.

    Closed sessions are sealed and never reopened for new work.

    Task history is append-only under normal operation; no force rewriting.

    WorkState is run-local evidence and progress, not canonical task state.

## Required Reading Before Implementation

Read the following before changing runtime code:

    project-docs/README.md
    project-docs/product/overview.md
    project-docs/engineering/README.md
    project-docs/engineering/architecture/overview.md
    project-docs/engineering/architecture/agent-harness.md
    project-docs/engineering/architecture/context-and-memory.md
    project-docs/engineering/testing.md

Then read every file in this plan directory.

Relevant existing agent notes:

    agent-notes/run-first-task-promotion-2026-07-07/
    agent-notes/conversation-task-run-lifecycle-2026-07-05/
    agent-notes/context-engine-git-native-plan/
    agent-notes/session-first-task-routing-plan/
    agent-notes/run-context-workstate-compaction-2026-07-06/

When those older notes conflict with this plan's repository topology or
session-store location, this plan controls future migration work. Existing
implemented harness behavior remains authoritative until each migration slice
is completed and verified.

## Branch And Commit Guidance

The implementation branch already exists:

    refactor/git-context-repository-migration

Use focused, verified commits. Recommended slices:

1. Service contracts and repository ownership types.
2. Git Context Engine process and SQLite journal.
3. Session repository on main.
4. Conversation segments and context cache.
5. Canonical task repository store.
6. Per-task session submodules.
7. Task-aware mutation roots and checkpoint commits.
8. Task-run persistence and cross-repository finalization.
9. Recovery and midnight rollover.
10. Git-native routing and task search.
11. Legacy migration and read-only compatibility.
12. Removal of old writers and task-state reducers.
13. Task catalog and virtual views.

## Do Not Do

- Do not rewrite the harness around the new service.
- Do not expose low-level commit or recovery operations to the model.
- Do not use MCP as the deterministic lifecycle transport.
- Do not let both the harness and service write Git.
- Do not keep Git and SQLite as competing task-state authorities.
- Do not create a Git commit for every harmless direct reply.
- Do not leave harmless conversation only in process memory.
- Do not store full file contents repeatedly in run tool records.
- Do not require root AGENTS.md for every task or overwrite a user's file.
- Do not use symbolic links as proof that external target contents are tracked
  by Git.
- Do not rewrite historical session repositories in place.
- Do not delete legacy data during migration.
- Do not introduce a harness version switch.
- Do not begin legacy cleanup before new-session and cross-session acceptance
  tests pass.

## Success Definition

The migration is successful when:

- New sessions store conversation directly in their main repository.
- New tasks are independent repositories from their first mutation.
- A later session can mount and continue an earlier task with full history.
- Old sessions retain exact task commit pointers.
- Twenty tasks can be used in one session without file contamination.
- Session-only conversation survives crashes and midnight rollover.
- Task completion validates actual repository files and outcomes.
- Task routing uses repository ownership before semantic similarity.
- Task context is derived from Git rather than an accumulating state.json.
- SQLite indexes can be rebuilt without losing completed task history.
- A crash between task and session commits is recovered deterministically.
- Existing legacy sessions remain readable.
