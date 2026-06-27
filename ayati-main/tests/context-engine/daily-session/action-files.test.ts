import { describe, expect, it } from "vitest";
import { validateToolActionFile } from "../../../src/context-engine/daily-session/index.js";

describe("daily session action files", () => {
  it("stores tool outputs as action records with optional external output refs", () => {
    expect(validateToolActionFile({
      schemaVersion: 1,
      actionId: "action-0001",
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
      tool: "read_file",
      input: { path: "/home/user/contract.pdf" },
      status: "success",
      summary: "Read contract.pdf and extracted text.",
      outputRef: "tasks/W-20260627-0001/actions/R-20260627-0001/action-0001-output.txt",
      createdAt: "2026-06-27T10:05:00+05:30",
    }).ok).toBe(true);
  });

  it("requires action input to be explicitly present", () => {
    const result = validateToolActionFile({
      schemaVersion: 1,
      actionId: "action-0001",
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
      tool: "read_file",
      status: "success",
      summary: "Missing input should fail.",
      createdAt: "2026-06-27T10:05:00+05:30",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("input is required.");
    }
  });
});
