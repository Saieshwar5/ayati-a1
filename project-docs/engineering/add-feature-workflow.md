# Add Feature Workflow

1. Read the relevant `project-docs` context.
2. Inspect existing modules and tests in the same domain.
3. Keep package boundaries intact.
4. Reuse existing providers, services, tools, stores, and static prompt helpers.
5. Add or update focused tests near the changed domain.
6. Run the narrow test first, then broader package tests if the change affects shared behavior.
7. Update `project-docs` when architecture, commands, API contracts, or agent guidance changes.

For task-context changes:

1. Read [Task Repositories](architecture/task-repositories.md).
2. Keep protocol/schema/service/Git responsibilities inside
   `ayati-git-context`; keep model-facing tool and harness integration inside
   `ayati-main`.
3. Preserve V1 mount-free selection, explicit request decisions, runtime-owned
   `.ayati/` writes, and one final task commit.
4. Add focused tests in both packages when a shared protocol or live flow
   changes.
5. Update protocol version and compatibility behavior deliberately when the
   wire contract changes.

Placement rule:

- If the feature affects intelligence, memory, tools, providers, events, permissions, runtime state, or personalization, it belongs in `ayati-main`.
- If the feature only affects terminal rendering, terminal input, local attachment queue UX, or CLI display behavior, it belongs in `ayati-cli`.
- New communication channels should be clients that talk to the daemon, not independent agent runtimes.
- Git Context service, repository-layout, request-lifecycle, and catalog code
  belongs in `ayati-git-context`.

Common test locations:

- Backend tests: `ayati-main/tests`
- Git Context tests: `ayati-git-context/tests`
- CLI tests: `ayati-cli/src/app/**/*.test.ts*`
