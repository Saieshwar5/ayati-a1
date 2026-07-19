# Testing Strategy

Tests use Vitest. Prefer deterministic local tests and mock provider, plugin,
transport, and external-computer boundaries unless a test is explicitly a live
acceptance scenario.

## Package Responsibilities

- `ayati-git-context/tests`: protocol contracts, SQLite services, session/task
  repositories, request lifecycle, mutation boundaries, attachments,
  finalization, and V1 end-to-end service flows.
- `ayati-main/tests`: model-facing routing tools, daemon integration, harness
  behavior, context projection, action execution, verification, transports,
  memory, and process lifecycle.
- `ayati-cli/src/app/**/*.test.ts*`: terminal rendering, input, commands,
  attachment queue behavior, and client message handling.

## V1 Task Repository Coverage

Changes to task continuity should cover the smallest relevant layer and the
cross-package boundary when applicable:

1. New task creation produces a normal `T-*` repository with the required
   `.ayati/` contract and ignored inbox.
2. Selection returns the stable working directory.
3. V1 activation rejects missing or ambiguous request decisions and accepts
   `requestDecision.kind="continue"` and `requestDecision.kind="create"`
   correctly.
4. Task-scoped paths cannot escape the canonical repository root, including
   through symlinks.
5. Attachment staging and reference adoption obey tracking and safety rules.
6. Finalization updates the request/task card, retains raw evidence outside
   task Git, and creates exactly one task commit on retry.
7. Restart can reopen the same task/request and working directory.
8. Discovery explains exact/path/continuation matches and keeps star, recency,
   frequency, and search separate from mutation authority.
9. Requested-directory registration preserves clean Git history, rejects dirty
   Git, and imports only an explicitly approved non-Git baseline.
10. Archive preservation and catalog rebuild validate repositories before any
    catalog write.
Existing focused suites include `simple-task-*`,
`task-discovery.test.ts`, `task-location-registration.test.ts`,
`task-catalog-rebuild.test.ts`,
`prepare-context-turn.test.ts`, `record-run-step.test.ts`,
`finalize-run.test.ts`, `task-bound-run-finalization.test.ts`, and the SQLite
service suites in `ayati-git-context/tests`.

## Harness and Live-Flow Coverage

In `ayati-main`, prove that the model-facing tools submit and preserve the V1
decision contract. Test repair behavior through stable repair codes and verify
that routing refreshes the active context before normal work tools run.

App-level tests should distinguish:

- read-only unbound runs from task-bound runs;
- direct clarification from task selection;
- new task from new request in an existing task;
- verified repository mutation from external side effects; and
- final response success from Git finalization success.

Feedback coverage should assert the same lifecycle at two levels. The compact
latest summary must retain repository, request, run-binding, and finalization
identity across successive events. The live report must reject V1 mounts,
missing working directories, missing or contradictory request decisions, and
commit/HEAD mismatches while accepting clarification backed only by an unbound
run.

For completed, failed, blocked, needs-user-input, run-limit, context-limit, and
tool-failure outcomes, assert both user-visible behavior and durable storage.

## Real Acceptance Scenarios

After deterministic tests pass, exercise representative multi-turn work:

- learning: resume a subject across days and add a new lesson request;
- website: create, reopen, improve, and inspect the same project repository;
- analysis: retain sources/results without committing large raw datasets;
- automation/computer use: distinguish repository changes from verified
  external outcomes.

For each scenario, inspect the final text, feedback trace, task repository,
`.ayati/task.md`, request files, Git history, ignored inbox state, and restart
behavior. Run `pnpm feedback:git-context` after each completed turn for the
operator-facing lifecycle view. See
[Headless Chat Scenarios](headless-chat-scenarios.md).

## Commands

Run the narrow suite first, then broaden according to impact:

```bash
pnpm --filter ayati-git-context test
pnpm --filter ayati-main test
pnpm --filter ayati-cli test
pnpm test
```

Build both sides after protocol or shared-type changes:

```bash
pnpm --filter ayati-git-context build
pnpm --filter ayati-main build
```
