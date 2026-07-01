import { describe, expect, it } from "vitest";
import {
  parseGitMemoryConversationMessageFile,
  renderGitMemoryConversationMessageFile,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory conversation markdown", () => {
  it("renders and parses per-message Markdown files", () => {
    const markdown = renderGitMemoryConversationMessageFile({
      seq: 14,
      role: "user",
      at: "2026-07-01T10:15:00+05:30",
      text: "Add one more story to that same file.",
      taskId: "W-20260701-0001",
      runId: "R-20260701-0001",
    }, {
      sessionId: "S-20260701-local",
    });

    expect(markdown).toBe([
      "# Message 000014",
      "",
      "Role: User",
      "At: 2026-07-01T10:15:00+05:30",
      "Session: S-20260701-local",
      "Task: W-20260701-0001",
      "Run: R-20260701-0001",
      "",
      "Add one more story to that same file.",
      "",
    ].join("\n"));
    expect(parseGitMemoryConversationMessageFile(markdown)).toEqual({
      seq: 14,
      role: "user",
      at: "2026-07-01T10:15:00+05:30",
      text: "Add one more story to that same file.",
      taskId: "W-20260701-0001",
      runId: "R-20260701-0001",
    });
  });
});
