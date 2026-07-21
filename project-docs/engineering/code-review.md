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
- Service-contract/implementation drift across `ayati-main` and
  `ayati-context-engine`.
- Missing restart, retry/idempotency, or repository-inspection
  coverage for workstream/resource changes.

Before merging significant backend changes, prefer:

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main test
```

For Context Engine changes, also prefer:

```bash
pnpm --filter ayati-context-engine build
pnpm --filter ayati-context-engine test
```

Before merging CLI changes, prefer:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli test
```
