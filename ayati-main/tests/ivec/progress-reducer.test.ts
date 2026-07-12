import { describe, expect, it } from "vitest";
import { reduceVerifiedWorkState } from "../../src/ivec/verification-contracts/progress-reducer.js";
import type { WorkState } from "../../src/ivec/types.js";

describe("reduceVerifiedWorkState", () => {
  it("records verified facts and evidence without synthetic completion", () => {
    const previous: WorkState = {
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
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

    expect(next.status).toBe("not_done");
    expect(next.summary).toContain("Verification contract passed");
    expect(next.verifiedFacts).toContain("Read-back hash verified for /tmp/a.txt.");
    expect(next.evidence).toContain("write_files.written_hashes_match: Verified read-back hashes for 2 written file(s).");
    expect(next.artifacts).toContain("/tmp/a.txt");
  });
});
