import { describe, expect, it } from "vitest";
import {
  FOCUS_CURRENT_REF,
  MAIN_BRANCH_REF,
  buildRunRef,
  buildScratchRef,
  buildWorkBranchName,
  buildWorkBranchRef,
  parseWorkBranchRef,
} from "../../../src/context-server/daily-session/index.js";

describe("daily session refs", () => {
  it("builds Git-native refs for focus, runs, scratch, and work branches", () => {
    expect(MAIN_BRANCH_REF).toBe("refs/heads/main");
    expect(FOCUS_CURRENT_REF).toBe("refs/ayati/focus/current");
    expect(buildRunRef("R-20260627-0001")).toBe("refs/ayati/runs/R-20260627-0001");
    expect(buildScratchRef("R-20260627-0001")).toBe("refs/scratch/R-20260627-0001");
    expect(buildWorkBranchName("W-20260627-0001", "Analyze Files")).toBe("work/W-20260627-0001-analyze-files");
    expect(buildWorkBranchRef("W-20260627-0001", "Analyze Files")).toBe(
      "refs/heads/work/W-20260627-0001-analyze-files",
    );
  });

  it("parses generated work branch refs and rejects malformed refs", () => {
    expect(parseWorkBranchRef("refs/heads/work/W-20260627-0001-analyze-files")).toMatchObject({
      branchName: "work/W-20260627-0001-analyze-files",
      workId: "W-20260627-0001",
      slug: "analyze-files",
    });
    expect(parseWorkBranchRef("refs/heads/main")).toBeNull();
    expect(parseWorkBranchRef("refs/heads/work/W-20260627-0001-../bad")).toBeNull();
  });
});
