import { describe, expect, it } from "vitest";
import {
  validateSessionEventRecord,
  validateTaskStateFile,
} from "../../../src/context-server/daily-session/index.js";

describe("daily session validation", () => {
  it("returns explicit errors instead of throwing on invalid task state", () => {
    const result = validateTaskStateFile({
      schemaVersion: 1,
      workId: "W-20260627-0001",
      status: "active",
      completed: "bad",
      open: [],
      facts: [{ text: "", source: "action-0001" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("completed must be an array of strings.");
      expect(result.errors).toContain("text must not be empty.");
    }
  });

  it("rejects invalid work branch refs on task branch creation events", () => {
    const result = validateSessionEventRecord({
      seq: 1,
      type: "task_branch_created",
      at: "2026-06-27T10:00:10+05:30",
      workId: "W-20260627-0001",
      branch: "work/W-20260627-0001-bad",
      ref: "refs/heads/work/W-20260627-0001-../bad",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("ref must be a valid work branch ref.");
    }
  });
});
