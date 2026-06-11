import { describe, expect, it } from "vitest";
import { reduceVerifiedTaskProgress } from "../../src/ivec/verification-contracts/progress-reducer.js";
import type { TaskProgressState } from "../../src/ivec/types.js";

describe("reduceVerifiedTaskProgress", () => {
  it("marks write_files verification as a completed milestone", () => {
    const previous: TaskProgressState = {
      status: "not_done",
      progressSummary: "",
      keyFacts: [],
      evidence: [],
    };

    const next = reduceVerifiedTaskProgress(previous, {
      passed: true,
      summary: "Verification contract passed from tool-owned assertions for write_files.",
      evidenceItems: [
        "write_files.written_hashes_match: Verified read-back hashes for 2 written file(s).",
      ],
      newFacts: [
        "Read-back hash verified for /tmp/a.txt.",
      ],
    });

    expect(next.status).toBe("likely_done");
    expect(next.completedMilestones).toContain("write_files completed and read-back hashes verified");
    expect(next.keyFacts).toContain("Read-back hash verified for /tmp/a.txt.");
  });
});

