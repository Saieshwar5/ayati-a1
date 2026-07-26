import { describe, expect, it } from "vitest";
import { reduceVerifiedWorkState } from "../../src/ivec/verification-contracts/progress-reducer.js";
import type { WorkState } from "../../src/ivec/types.js";

describe("reduceVerifiedWorkState", () => {
  it("leaves WorkState unchanged because tool proof belongs to the run journal", () => {
    const previous: WorkState = {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    };

    const next = reduceVerifiedWorkState(previous, {
      passed: true,
      summary: "Verification contract passed from tool-owned assertions for write_files.",
      evidenceItems: [
        "write_files.written_hashes_match: Verified read-back hashes for 2 written file(s).",
      ],
      newFacts: [
        "Read-back hash verified for /tmp/a.txt.",
      ],
      artifacts: [
        "/tmp/a.txt",
      ],
    });

    expect(next).toBe(previous);
  });
});
