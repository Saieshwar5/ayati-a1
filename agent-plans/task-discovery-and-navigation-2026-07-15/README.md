# Task Discovery And Navigation

Created: 2026-07-15

Plan set: Task Discovery And Navigation

Status: evolving design plan. The first foundation, the resource catalog, is
documented. More task indexing, search, sorting, virtual-directory, routing,
and activation ideas will be added here before the combined implementation
plan is finalized.

## Purpose

This directory collects the design for helping Ayati reliably find and resume
tasks without embeddings.

The intended model is:

```text
task repositories and commits = canonical task truth
SQLite catalogs and indexes = fast deterministic discovery
in-memory caches = hot agent-ready navigation context
virtual task views = human-like browsing and organization
verified task activation = safe boundary before work begins
```

The system should eventually let the agent locate a task through several
independent signals:

- exact task identity or confirmed alias
- owned file, directory, or other resource
- user attachment or task input
- title, objective, tags, and current commit-derived task state
- recent, frequent, starred, active, blocked, or archived status
- session and activity timeline
- deterministic Git history and repository-content fallback search
- user-confirmed routing corrections

No one weak signal, such as recency or textual similarity, should silently
authorize a mutation.

## Files In This Plan

- `resource-catalog.md`: first plan; indexes files and directories created or
  mutated by the agent and files attached or selected by the user so resources
  can reliably lead back to tasks.
- `task-catalog.md`: second plan; expands the current minimal SQLite task
  registry into a rich, commit-derived, explainable search catalog without
  making SQLite a competing task-state authority.
- `task-views-and-navigation.md`: third plan; provides computer-like Recent,
  Starred, Frequent, status, category, resource, session, and custom smart
  views over canonical tasks without moving or duplicating task repositories.
- `task-retrieval-architecture.md`: synthesis plan for embedding-free task
  retrieval and safe continuation through an Agent Home, task passports,
  independent indexes, fingerprints, Git fallback, routing corrections,
  conversation focus, explainable candidates, and verified activation handles.

Future ideas and plans should be added as focused files in this directory and
listed here. Once the individual systems are understood, this directory can be
turned into a staged master implementation plan.

## Current First Principle

Resource identity is the strongest task-discovery signal available.

```text
exact owned resource
-> owning task
-> verify current repository and task commit
-> activate task
-> allow task-scoped work
```

Attachments and read-only references are searchable relationships, but they
must not automatically become exclusive task ownership.

## Relationship To Existing Migration

This plan extends:

```text
agent-notes/git-context-engine-service-migration-2026-07-12/
```

It preserves that plan's ownership model:

- Git Context Engine is the sole context persistence owner.
- Git stores completed durable task history.
- SQLite stores rebuildable indexes and live operational state.
- Every durable task has a canonical independent repository.
- Read-only files are references, not owned task resources.
- Task ownership must be resolved before mutation.
