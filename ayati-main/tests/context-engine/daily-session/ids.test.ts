import { describe, expect, it } from "vitest";
import {
  createActionId,
  createAssetId,
  createRunId,
  createWorkId,
  isActionId,
  isAssetId,
  isRunId,
  isSessionId,
  isWorkId,
  sessionIdFromCompactDate,
  slugifyTitle,
} from "../../../src/context-engine/daily-session/index.js";

describe("daily session ids", () => {
  it("uses date based session ids and derived sequence ids", () => {
    expect(isSessionId("2026-06-27")).toBe(true);
    expect(isSessionId("2026-02-30")).toBe(false);

    expect(createWorkId("2026-06-27", 1)).toBe("W-20260627-0001");
    expect(createRunId("2026-06-27", 12)).toBe("R-20260627-0012");
    expect(createAssetId("2026-06-27", 7)).toBe("A-20260627-0007");
    expect(createActionId(3)).toBe("action-0003");

    expect(isWorkId("W-20260627-0001")).toBe(true);
    expect(isRunId("R-20260627-0012")).toBe(true);
    expect(isAssetId("A-20260627-0007")).toBe(true);
    expect(isActionId("action-0003")).toBe(true);
  });

  it("rejects malformed ids and unsafe sequences", () => {
    expect(isWorkId("W-2026-06-27-1")).toBe(false);
    expect(isRunId("R-20260631-0001")).toBe(false);
    expect(isAssetId("A-20260627-abc")).toBe(false);
    expect(isActionId("action-1")).toBe(false);

    expect(() => createWorkId("2026-06-27", 0)).toThrow("Sequence");
    expect(() => sessionIdFromCompactDate("20260631")).toThrow("Invalid compact");
  });

  it("creates deterministic branch-safe slugs", () => {
    expect(slugifyTitle("Fix upload bug")).toBe("fix-upload-bug");
    expect(slugifyTitle("  Analyze: Contract #1 / Contract #2  ")).toBe("analyze-contract-1-contract-2");
    expect(slugifyTitle("!!!", "task")).toBe("task");
  });
});
