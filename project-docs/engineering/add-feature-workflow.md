# Add Feature Workflow

1. Read the relevant `project-docs` context.
2. Inspect existing modules and tests in the same domain.
3. Keep package boundaries intact.
4. Reuse existing providers, services, tools, stores, and static prompt helpers.
5. Add or update focused tests near the changed domain.
6. Run the narrow test first, then broader package tests if the change affects shared behavior.
7. Update `project-docs` when architecture, commands, API contracts, or agent guidance changes.

Placement rule:

- If the feature affects intelligence, memory, tools, providers, events, permissions, runtime state, or personalization, it belongs in `ayati-main`.
- If the feature only affects terminal rendering, terminal input, local attachment queue UX, or CLI display behavior, it belongs in `ayati-cli`.
- New communication channels should be clients that talk to the daemon, not independent agent runtimes.

Common test locations:

- Backend tests: `ayati-main/tests`
- CLI tests: `ayati-cli/src/app/**/*.test.ts*`
