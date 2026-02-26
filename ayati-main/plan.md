# Fix: Agent keeps running after task is already solved

## Problem
The controller decides the next step but is blind to what previous steps found.
It only sees `Step 1: [success] Check RAM usage` — no data, no facts, no summary.
So it keeps issuing new steps for the same already-answered question.

## 3 changes (all small, no new files)

### Change 1 — Add `summary` to `StepSummary` (`types.ts` + `executor.ts`)

**`src/ivec/types.ts`** — add one field to `StepSummary`:
```typescript
export interface StepSummary {
  step: number;
  intent: string;
  outcome: string;
  evidence: string;
  summary: string;      // ← NEW: executor's finalText (truncated to 500 chars)
  newFacts: string[];
  artifacts: string[];
}
```

**`src/ivec/executor.ts`** — populate it in `executeStep()` return:
```typescript
return {
  step: stepNumber,
  intent: directive.intent,
  outcome: verifyOut.passed ? "success" : "failed",
  evidence: verifyOut.evidence,
  summary: actOut.finalText.slice(0, 500),   // ← NEW
  newFacts: verifyOut.newFacts,
  artifacts: verifyOut.artifacts,
};
```

### Change 2 — Show results in controller prompt (`controller.ts`)

**`src/ivec/controller.ts`** — update `buildControllerPrompt` step history
from just `[outcome] intent` to include the summary or evidence:
```typescript
const stepHistory = state.completedSteps
  .slice(-5)
  .map((s) => {
    let line = `  Step ${s.step}: [${s.outcome}] ${s.intent}`;
    if (s.summary) line += `\n    Result: ${s.summary.slice(0, 300)}`;
    else if (s.evidence) line += `\n    Evidence: ${s.evidence.slice(0, 300)}`;
    return line;
  })
  .join("\n");
```

### Change 3 — Remove Gate 2 from verification gates (`verification-gates.ts`)

**`src/ivec/verification-gates.ts`** — delete the "All-success gate" (lines 35-44).

Currently this gate auto-passes any step with successful tool calls and returns
`newFacts: []`, which prevents the LLM verify from ever extracting facts.
Without it, successful steps fall through to LLM verify which returns real facts.

Keep Gate 1 (error gate) and Gate 3 (no-tools gate).

## Test updates

**`tests/ivec/verification-gates.test.ts`**:
- The test "returns passed: true when all tool calls succeed" should now
  expect `null` (falls through to LLM verify) instead of a gate result.

**`tests/ivec/agent-loop.test.ts`**:
- The multi-step test mock sequence needs a verify LLM call added (since
  Gate 2 no longer auto-passes). Update callCount sequence accordingly.

## Files touched
1. `src/ivec/types.ts` — add `summary` to `StepSummary`
2. `src/ivec/executor.ts` — populate `summary` from `actOut.finalText`
3. `src/ivec/controller.ts` — show summary/evidence in step history
4. `src/ivec/verification-gates.ts` — remove Gate 2
5. `tests/ivec/verification-gates.test.ts` — update expectation
6. `tests/ivec/agent-loop.test.ts` — update mock call sequence
