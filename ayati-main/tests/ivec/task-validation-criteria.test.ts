import { describe, expect, it } from "vitest";
import { validateCriterionProofSelections } from "../../src/ivec/agent-runner/task-validation-criteria.js";

describe("task validation criterion proofs", () => {
  const writeRef = "run:RUN-1:step:1:call:write-page:outcome:0";
  const searchRef = "run:RUN-1:step:2:call:search-cards:outcome:0";

  it("accepts one same-decision proof mapping for every acceptance criterion", () => {
    expect(validateCriterionProofSelections({
      acceptance: ["The page exists.", "Exactly two cards exist."],
      outcomeRefs: [writeRef, searchRef],
      selections: [
        { criterionIndex: 0, outcomeRefs: [writeRef] },
        { criterionIndex: 1, outcomeRefs: [searchRef] },
      ],
    })).toBeUndefined();
  });

  it("rejects missing, duplicate, and unselected proof references", () => {
    expect(validateCriterionProofSelections({
      acceptance: ["The page exists.", "Exactly two cards exist."],
      outcomeRefs: [writeRef, searchRef],
      selections: [{ criterionIndex: 0, outcomeRefs: [writeRef] }],
    })).toMatchObject({ message: expect.stringContaining("missing acceptance indexes: 1") });

    expect(validateCriterionProofSelections({
      acceptance: ["The page exists."],
      outcomeRefs: [writeRef],
      selections: [
        { criterionIndex: 0, outcomeRefs: [writeRef] },
        { criterionIndex: 0, outcomeRefs: [writeRef] },
      ],
    })).toMatchObject({ message: expect.stringContaining("mapped more than once") });

    expect(validateCriterionProofSelections({
      acceptance: ["The page exists."],
      outcomeRefs: [writeRef],
      selections: [{ criterionIndex: 0, outcomeRefs: [searchRef] }],
    })).toMatchObject({
      message: expect.stringContaining("not selected for validation"),
      subjects: [searchRef],
    });
  });

  it("does not accept criterion mappings for an unbound responsibility", () => {
    expect(validateCriterionProofSelections({
      acceptance: [],
      outcomeRefs: [writeRef],
      selections: [{ criterionIndex: 0, outcomeRefs: [writeRef] }],
    })).toMatchObject({
      message: expect.stringContaining("only for a bound request"),
    });
  });
});
