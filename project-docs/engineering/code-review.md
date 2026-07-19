# Code Review Workflow

Review priorities:

- Behavioral regressions.
- Tool safety and validation gaps.
- Prompt/context changes that alter agent behavior unexpectedly.
- Memory persistence or recall correctness.
- Provider compatibility.
- Transport contract compatibility.
- Missing tests for changed behavior.
- Runtime data or secret leakage.
- Workstream/request selection ambiguity or accidental implicit authority.
- Regressions that place deliverables in context Git, infer authority from
  binding alone, or allow model-owned lifecycle commits.
- Protocol/client/server drift across `ayati-main` and `ayati-git-context`.
- Missing restart, retry/idempotency, or repository-inspection
  coverage for workstream/resource changes.

Before merging significant backend changes, prefer:

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main test
```

For Git Context changes, also prefer:

```bash
pnpm --filter ayati-git-context build
pnpm --filter ayati-git-context test
```

Before merging CLI changes, prefer:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli test
```
