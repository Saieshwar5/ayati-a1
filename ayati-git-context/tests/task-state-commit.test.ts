import { describe, expect, it } from "vitest";
import {
  parseTaskStateCommit,
  persistentTaskStatusForOutcome,
  renderTaskStateCommit,
  TASK_STATE_VERSION,
} from "../src/tasks/task-state-commit.js";

describe("task state commits", () => {
  it("round-trips the compact cumulative state used by the next task run", () => {
    const message = renderTaskStateCommit({
      version: TASK_STATE_VERSION,
      taskId: "W-20260714-0001",
      title: "Aurora Coffee website",
      status: "in_progress",
      state: "The responsive coffee website exists with its menu and contact details; workspace publication remains pending.",
      validation: "failed",
      next: "Publish the verified site into the requested workspace directory.",
      runId: "R-20260714-0004",
      sessionId: "S-20260714-local",
      conversationId: "S-20260714-local-C-000007",
      conversationHash: "sha256:" + "a".repeat(64),
      runOutcome: "incomplete",
    });

    expect(message).toContain("Task-State: The responsive coffee website exists");
    expect(message).toContain("Ayati-Event: task_run_committed");
    expect(parseTaskStateCommit(message)).toEqual({
      version: TASK_STATE_VERSION,
      taskId: "W-20260714-0001",
      title: "Aurora Coffee website",
      status: "in_progress",
      state: "The responsive coffee website exists with its menu and contact details; workspace publication remains pending.",
      validation: "failed",
      next: "Publish the verified site into the requested workspace directory.",
      runId: "R-20260714-0004",
      sessionId: "S-20260714-local",
      conversationId: "S-20260714-local-C-000007",
      conversationHash: "sha256:" + "a".repeat(64),
      runOutcome: "incomplete",
    });
  });

  it("maps terminal run outcomes to the persistent task status", () => {
    expect(persistentTaskStatusForOutcome("done")).toBe("done");
    expect(persistentTaskStatusForOutcome("incomplete")).toBe("in_progress");
    expect(persistentTaskStatusForOutcome("failed")).toBe("in_progress");
    expect(persistentTaskStatusForOutcome("blocked")).toBe("blocked");
    expect(persistentTaskStatusForOutcome("needs_user_input")).toBe("blocked");
  });

  it("ignores bootstrap and legacy messages that do not contain a complete state", () => {
    expect(parseTaskStateCommit("Initialize task repository\n\nTask-Id: W-1"))
      .toBeUndefined();
  });
});
