# Add Feature Workflow

1. Read the relevant `project-docs` context.
2. Inspect existing modules and tests in the same domain.
3. Keep package boundaries intact.
4. Reuse existing providers, services, tools, stores, and static prompt helpers.
5. Add or update focused tests near the changed domain.
6. Run the narrow test first, then broader package tests if the change affects shared behavior.
7. Update `project-docs` when architecture, commands, API contracts, or agent guidance changes.

For workstream/resource changes:

1. Read [Workstreams and Resources](architecture/workstreams-and-resources.md).
2. Keep contracts/schema/service/Git responsibilities inside
   `ayati-context-engine`; keep model-facing tool and harness integration inside
   `ayati-main`.
3. Preserve context-only workstream Git, real resource locations, explicit
   request decisions, exact resource mutation scopes, and at most one context
   commit during finalization.
4. Add focused tests in both packages when a shared contract or live flow
   changes.
5. Keep runtime validation at the service or dynamic-input boundary; do not
   rely on a transport layer for domain correctness.

Placement rule:

- If the feature affects intelligence, memory, tools, providers, events, permissions, runtime state, or personalization, it belongs in `ayati-main`.
- If the feature only affects terminal rendering, terminal input, local attachment queue UX, or CLI display behavior, it belongs in `ayati-cli`.
- New communication channels should be clients that talk to the daemon, not independent agent runtimes.
- Context Engine service, workstream layout, resource/request lifecycle, and catalog code
  belongs in `ayati-context-engine`.

Common test locations:

- Backend tests: `ayati-main/tests`
- Context Engine tests: `ayati-context-engine/tests`
- CLI tests: `ayati-cli/src/app/**/*.test.ts*`
