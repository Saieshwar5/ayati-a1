# Testing Plan

## Test Strategy

Test deterministic contracts and adapters before live provider scenarios:

```text
contract/schema tests
-> repository and policy unit tests
-> adapter unit tests
-> Git Context Engine integration tests
-> ayati-main harness integration tests
-> failure-injection/recovery tests
-> full package and monorepo tests
-> isolated live daemon acceptance tests
```

Avoid networked provider calls in normal Vitest suites. Remote adapters use
deterministic fake providers with controllable timeouts, versions, and
idempotency behavior.

## Workspace And Task Creation

- New managed task becomes `owned_checkout` with an implicit checkout resource.
- New/empty requested directory becomes `owned_checkout`.
- Explicit existing non-Git project root becomes `adopted_checkout` and imports
  one baseline without counting it as a task run.
- Naming one file inside an existing directory chooses `managed_sidecar`, not
  directory adoption.
- Existing Git worktree is rejected as owned/adopted placement and accepted as
  a sidecar resource proposal.
- Old managed/requested contracts remain readable during compatibility.
- Task manifests cannot overwrite user `AGENTS.md` or user-owned `.ayati`
  conflicts.

## Resource Catalog And Binding

- Exact canonical path reuses one resource record.
- Verified aliases/renames resolve to the same resource.
- Model-only unsupported locators cannot create bindings.
- User-message, clarification, and verified-read evidence can create bindings.
- Binding the same resource to several tasks preserves all relationships.
- Ambiguous mutation routing asks for clarification.
- Binding capabilities do not authorize mutation without current-run intent.
- Portable manifests validate deterministically and exclude exact credentials.
- Historical task without manifests projects an implicit checkout resource.

## Authority And Concurrency

- Only one active/uncertain write lease exists per resource.
- Many read operations can coexist.
- Multi-resource lease acquisition is all-or-none and uses stable ordering.
- Expired undispatched lease can recover cleanly.
- Expired dispatched lease remains blocked until reconciliation.
- Baseline changes outside Ayati's lease are detected before mutation.
- Relative, unbound, outside-scope, and symlink-escaping paths fail closed.
- Authority tokens are never persisted raw outside exact idempotent response
  recovery.

## Standalone File

- Patch a user-created text file in place and verify before/after hashes.
- Replace a file only with a current full-read base hash.
- Preserve permissions and expected file type.
- Detect concurrent editor change between read and write.
- Reject broken/looping/escaping symlinks.
- Verify sensitive JSON without persisting secret values.
- Ensure the sidecar contains manifests/history, not a canonical content copy.
- Re-run a later turn using exact resource routing and a new baseline.

## Published Output

- Generate and validate an internal artifact, then publish atomically.
- Create a missing destination.
- Replace an existing destination only with current replacement intent and
  baseline.
- Crash before rename leaves the original intact and recovers temporary files.
- Crash after rename reconstructs and persists the receipt without publishing
  again.
- Completion contains both internal asset and external publication outcome.
- No `.git` or `.ayati` directory is created in a broad destination directory.

## Existing User Git Repository

- Modify a clean target while unrelated dirty files exist.
- Preserve unrelated staged, unstaged, and untracked paths exactly.
- Detect concurrent HEAD change and target change.
- Do not change origin, branch, Git configuration, or hooks.
- Default edit leaves the user repository uncommitted.
- Explicit commit contains only run-produced authorized changes.
- Refuse explicit commit when target changes cannot be separated from
  pre-existing user changes.
- Handle detached HEAD, worktrees, submodules, ignored files, and hook failure
  with deterministic supported/rejected outcomes.
- Sidecar task commit and optional user-repository commit remain distinct.

## Remote API Or External Effect

- Resolve identity without persisting credentials.
- Write journal/idempotency key before dispatch.
- Successful operation records provider ID, verification, and receipt.
- Timeout before dispatch is safely retryable.
- Timeout after dispatch becomes unknown and queries operation status.
- Startup recovery does not duplicate an already-applied effect.
- Provider version conflict fails without overwriting concurrent state.
- Unsupported non-idempotent or unverifiable tool cannot claim completion.
- Redaction removes authorization headers, tokens, cookies, and sensitive body
  fields from context and Git evidence.

## WorkState And Completion

- Checkout-only completion remains backward compatible.
- External-only completion succeeds with verified resource receipt and no fake
  internal asset.
- Mixed completion requires all declared assets/resources.
- Receipt from another task or run is rejected.
- Superseded/invalidated observation is rejected.
- Partial, failed, unknown, or recovery-required receipt blocks done outcome.
- Final WorkState retains bounded resource summaries and receipt references.
- Historical completion without `resources` reads as an empty list.

## Storage And Recovery Failure Injection

Inject failure after every phase:

- prepared;
- authority acquired;
- external request dispatched;
- effect observed;
- receipt persisted;
- task finalized;
- session staged/committed; and
- operation completed.

For each phase prove:

- convergence after restart;
- no duplicate task/session commit;
- no duplicate external effect;
- no silent lease release for uncertain operations;
- correct task/run outcome and WorkState;
- complete conversation and resource evidence; and
- preserved external/user repository state.

## Migration And Rebuild

- Upgrade a database with existing tasks and active historical sessions.
- Preserve every task HEAD, session gitlink, and task working directory.
- Backfill workspace modes conservatively.
- Project implicit checkout bindings without rewriting task history.
- Rebuild resource/binding/receipt indexes from task and session Git.
- Mark missing machine-local locators `needs_rebind` rather than guessing.
- Re-running migration/rebuild is idempotent.

## Performance And Context

- Exact lookup remains indexed with large task/resource catalogs.
- Context projection is bounded and prioritizes current-turn resources.
- Many bindings do not overflow task context or tool schemas.
- Full external contents are not duplicated into prompts.
- Resource receipts remain bounded under large provider responses.

## Live Daemon Acceptance Scenarios

Run in an isolated data/workspace root through the real client/daemon message
path:

1. Casual informational conversation creates no task.
2. Read-only inspection of an external file remains a session run.
3. Create a website from scratch and continue it normally.
4. Adopt an explicitly named existing non-Git project directory.
5. Edit a standalone user-created file through a sidecar and continue it in a
   later turn.
6. Generate and publish a report to an external destination.
7. Edit a dirty existing Git repository without touching unrelated state; then
   explicitly request a safe commit.
8. Build an owned artifact and perform a fake/controlled external deployment
   in one mixed task.
9. Force a post-effect/pre-finalization restart and prove no duplicate effect.
10. Restart on a later session/date and recall the correct task by exact
    resource identity.

Collect conversation files, run evidence, task/session logs, SQLite rows,
receipts, external-state hashes/status, feedback records, and clean/expected Git
status. Remove isolated daemons after testing.

## Required Verification Commands

During implementation, run the smallest relevant focused suites first, then:

```text
pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context test
pnpm --filter ayati-main build
pnpm --filter ayati-main test
pnpm build
pnpm test
git diff --check
```

## Acceptance Definition

The implementation passes only when external resources remain canonical in
place, mutation authority is exact and current-run scoped, receipts prove real
outcomes, task/session history is complete, user Git state is preserved, and
every injected crash converges without a duplicate external effect.
