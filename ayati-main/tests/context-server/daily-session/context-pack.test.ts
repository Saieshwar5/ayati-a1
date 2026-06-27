import { describe, expect, it } from "vitest";
import {
  buildDailySessionMachineContextPack,
  type DailySessionContext,
} from "../../../src/context-server/daily-session/index.js";

describe("buildDailySessionMachineContextPack", () => {
  it("renders a compact machine-readable active task context", () => {
    const pack = buildDailySessionMachineContextPack({
      session: {
        sessionId: "2026-06-27",
        conversationTail: [{
          seq: 1,
          role: "user",
          at: "2026-06-27T10:00:00+05:30",
          text: "continue",
        }],
        eventTail: [],
        assets: [{
          assetId: "A-20260627-0001",
          kind: "user_file",
          name: "contract.pdf",
          path: "/home/user/contract.pdf",
          createdAt: "2026-06-27T10:00:00+05:30",
        }],
      },
      focus: {
        status: "active",
        ref: "refs/heads/work/W-20260627-0001-analyze-files",
        workId: "W-20260627-0001",
      },
      task: {
        ref: "refs/heads/work/W-20260627-0001-analyze-files",
        task: {
          schemaVersion: 1,
          workId: "W-20260627-0001",
          sessionId: "2026-06-27",
          title: "Analyze files",
          objective: "Analyze attached files.",
          status: "active",
          createdAt: "2026-06-27T10:00:00+05:30",
          updatedAt: "2026-06-27T10:20:00+05:30",
        },
        state: {
          schemaVersion: 1,
          workId: "W-20260627-0001",
          status: "active",
          completed: ["Read contract.pdf"],
          open: ["Write summary"],
          facts: [{ text: "Fact", source: "action-0001" }],
          next: "Write summary",
        },
        assets: [],
        recentRuns: [],
        recentCommits: [{
          commit: "abc123",
          message: `complete run R-20260627-0001 for W-20260627-0001

Read the attached contract.

Ayati-Session: 2026-06-27
Ayati-Work: W-20260627-0001
Ayati-Run: R-20260627-0001
Ayati-Event: run_completed
`,
          trailers: {
            raw: {
              "Ayati-Session": ["2026-06-27"],
              "Ayati-Work": ["W-20260627-0001"],
              "Ayati-Run": ["R-20260627-0001"],
              "Ayati-Event": ["run_completed"],
            },
            sessionId: "2026-06-27",
            workId: "W-20260627-0001",
            runId: "R-20260627-0001",
            event: "run_completed",
          },
        }],
      },
    } satisfies DailySessionContext);

    expect(pack.session).toMatchObject({
      sessionId: "2026-06-27",
      assetCount: 1,
    });
    expect(pack.task).toMatchObject({
      workId: "W-20260627-0001",
      title: "Analyze files",
      completed: ["Read contract.pdf"],
      open: ["Write summary"],
      next: "Write summary",
    });
    expect(pack.task?.recentCommits[0]).toMatchObject({
      commit: "abc123",
      subject: "complete run R-20260627-0001 for W-20260627-0001",
      summary: "Read the attached contract.",
      trailers: {
        runId: "R-20260627-0001",
      },
    });
  });
});
