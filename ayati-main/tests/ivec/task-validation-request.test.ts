import { describe, expect, it } from "vitest";
import { validateTaskValidationRequest } from "../../src/ivec/agent-runner/task-validation-request.js";

describe("task validation request policy", () => {
  it("accepts a bounded set of exact outcome references", () => {
    expect(validateTaskValidationRequest([
      "run:RUN-1:step:1:call:read-1:outcome:0",
      "run:RUN-1:step:1:call:read-1:outcome:1",
    ])).toBeUndefined();
  });

  it("requires at least one outcome reference", () => {
    expect(validateTaskValidationRequest([])).toMatchObject({
      message: expect.stringContaining("at least one exact current-run outcomeRef"),
      subjects: [],
    });
    expect(validateTaskValidationRequest(undefined)).toMatchObject({
      message: expect.stringContaining("at least one exact current-run outcomeRef"),
    });
  });

  it("rejects empty outcome references", () => {
    expect(validateTaskValidationRequest(["   "])).toMatchObject({
      message: expect.stringContaining("non-empty exact reference"),
      subjects: [],
    });
  });

  it("rejects duplicate outcome references", () => {
    const outcomeRef = "run:RUN-1:step:1:call:read-1:outcome:1";
    expect(validateTaskValidationRequest([outcomeRef, outcomeRef])).toMatchObject({
      message: expect.stringContaining("must be unique"),
      subjects: [outcomeRef, outcomeRef],
    });
  });

  it("accepts at most twelve outcome references", () => {
    const outcomeRefs = Array.from({ length: 13 }, (_, index) => `outcome-${index}`);
    expect(validateTaskValidationRequest(outcomeRefs)).toMatchObject({
      message: expect.stringContaining("at most twelve"),
      subjects: outcomeRefs,
    });
  });
});
