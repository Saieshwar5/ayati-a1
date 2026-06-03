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

Before merging significant backend changes, prefer:

```bash
pnpm --filter ayati-main build
pnpm --filter ayati-main test
```

Before merging CLI changes, prefer:

```bash
pnpm --filter ayati-cli build
pnpm --filter ayati-cli test
```
