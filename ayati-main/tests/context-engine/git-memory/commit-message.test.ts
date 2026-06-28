import { describe, expect, it } from "vitest";
import {
  parseGitMemoryCommitTrailers,
  renderGitMemoryCommitMessage,
} from "../../../src/context-engine/git-memory/index.js";

describe("git memory commit messages", () => {
  it("renders checkpoint commits with parseable v2 trailers", () => {
    const message = renderGitMemoryCommitMessage({
      subject: "ayati: complete run R-20260628-0001",
      summary: "Inspected upload handling and found a validation mismatch.",
      completed: ["Read upload server implementation"],
      open: ["Patch validation handling"],
      notes: ["Conversation remains canonical on the session main branch."],
      trailers: {
        sessionId: "S-20260628-local",
        taskId: "W-20260628-0001",
        runId: "R-20260628-0001",
        event: "run_completed",
        status: "completed",
        at: "2026-06-28T09:10:00+05:30",
        branch: "task/W-20260628-0001-fix-upload-handling",
        conversationSeq: { fromSeq: 1, toSeq: 2 },
      },
    });

    expect(message).toContain("Summary:\nInspected upload handling and found a validation mismatch.");
    expect(message).toContain("Completed:\n- Read upload server implementation");
    expect(message).toContain("Ayati-Schema-Version: 1");
    expect(message).toContain("Ayati-Session-Id: S-20260628-local");
    expect(message).toContain("Ayati-Task-Id: W-20260628-0001");
    expect(message).toContain("Ayati-Run-Id: R-20260628-0001");
    expect(message).toContain("Ayati-Conversation-Seq: 1-2");
  });

  it("parses machine trailers used by retrieval scripts", () => {
    const parsed = parseGitMemoryCommitTrailers(`ayati: complete run R-20260628-0001

Summary:
Inspected upload handling.

Ayati-Schema-Version: 1
Ayati-Session-Id: S-20260628-local
Ayati-Task-Id: W-20260628-0001
Ayati-Run-Id: R-20260628-0001
Ayati-Event: run_completed
Ayati-Status: completed
Ayati-At: 2026-06-28T09:10:00+05:30
Ayati-Branch: task/W-20260628-0001-fix-upload-handling
Ayati-Conversation-Seq: 1-2
Ayati-Action-Id: ACT-20260628-000001
Ayati-Action-Id: ACT-20260628-000002
`);

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      event: "run_completed",
      status: "completed",
      at: "2026-06-28T09:10:00+05:30",
      branch: "task/W-20260628-0001-fix-upload-handling",
      conversationSeq: { fromSeq: 1, toSeq: 2 },
    });
    expect(parsed.raw["Ayati-Action-Id"]).toEqual([
      "ACT-20260628-000001",
      "ACT-20260628-000002",
    ]);
  });
});
