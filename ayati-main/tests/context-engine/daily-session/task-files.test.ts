import { describe, expect, it } from "vitest";
import {
  taskActionFilePath,
  taskActionOutputPath,
  taskActionsDirectory,
  taskAssetsPath,
  taskDirectory,
  taskFilePath,
  taskFinalOutputPath,
  taskRunSummaryPath,
  taskStatePath,
  validateTaskAssetRecord,
  validateTaskFile,
  validateTaskRunSummaryFile,
  validateTaskStateFile,
} from "../../../src/context-engine/daily-session/index.js";

describe("daily session task branch files", () => {
  it("uses one unique task directory per work id", () => {
    expect(taskDirectory("W-20260627-0001")).toBe("tasks/W-20260627-0001");
    expect(taskFilePath("W-20260627-0001")).toBe("tasks/W-20260627-0001/task.json");
    expect(taskStatePath("W-20260627-0001")).toBe("tasks/W-20260627-0001/state.json");
    expect(taskAssetsPath("W-20260627-0001")).toBe("tasks/W-20260627-0001/assets.jsonl");
    expect(taskActionsDirectory("W-20260627-0001", "R-20260627-0001")).toBe(
      "tasks/W-20260627-0001/actions/R-20260627-0001",
    );
    expect(taskActionFilePath("W-20260627-0001", "R-20260627-0001", "action-0001")).toBe(
      "tasks/W-20260627-0001/actions/R-20260627-0001/action-0001.json",
    );
    expect(taskActionOutputPath("W-20260627-0001", "R-20260627-0001", "action-0001")).toBe(
      "tasks/W-20260627-0001/actions/R-20260627-0001/action-0001-output.txt",
    );
    expect(taskRunSummaryPath("W-20260627-0001", "R-20260627-0001")).toBe(
      "tasks/W-20260627-0001/summaries/R-20260627-0001.json",
    );
    expect(taskFinalOutputPath("W-20260627-0001")).toBe("tasks/W-20260627-0001/outputs/final.json");
  });

  it("validates task identity, state, asset, and run summary files", () => {
    expect(validateTaskFile({
      schemaVersion: 1,
      workId: "W-20260627-0001",
      sessionId: "2026-06-27",
      title: "Analyze files",
      objective: "Analyze the attached files and summarize important points.",
      status: "active",
      createdAt: "2026-06-27T10:00:10+05:30",
      updatedAt: "2026-06-27T10:25:00+05:30",
    }).ok).toBe(true);

    expect(validateTaskStateFile({
      schemaVersion: 1,
      workId: "W-20260627-0001",
      status: "active",
      completed: ["Read the attached contract file"],
      open: ["Write final summary"],
      facts: [{ text: "The contract has a 30-day termination clause.", source: "R-20260627-0001/action-0002" }],
      next: "Write final summary",
    }).ok).toBe(true);

    expect(validateTaskAssetRecord({
      assetId: "A-20260627-0001",
      role: "input",
      kind: "user_file",
      name: "contract.pdf",
      sessionAssetId: "A-20260627-0001",
    }).ok).toBe(true);

    expect(validateTaskRunSummaryFile({
      schemaVersion: 1,
      runId: "R-20260627-0001",
      workId: "W-20260627-0001",
      status: "completed",
      summary: "Read the attached contract and extracted key terms.",
      completed: ["Read contract.pdf"],
      open: ["Write final summary"],
      actions: ["action-0001", "action-0002"],
      createdAt: "2026-06-27T10:25:00+05:30",
    }).ok).toBe(true);
  });
});
