import { describe, expect, it } from "vitest";
import {
  buildGitMemoryTaskRunCommitInput,
  type GitMemoryHarnessRunResultForContext,
} from "../../../src/context-engine/git-memory/index.js";

describe("buildGitMemoryTaskRunCommitInput", () => {
  it("maps harness run results into git-memory task run commits", () => {
    const result: GitMemoryHarnessRunResultForContext = {
      type: "reply",
      status: "completed",
      content: "I fixed the upload validation mismatch.",
      totalIterations: 2,
      totalToolCalls: 3,
      runPath: "data/runs/r1",
      taskSummary: {
        taskStatus: "open",
        summary: "Patched upload validation.",
        completedMilestones: ["Identified the validation path."],
        openWork: ["Run upload integration tests."],
        keyFacts: ["Uploads pass through the multipart parser."],
        nextAction: "Run upload integration tests.",
      },
      workState: {
        status: "not_done",
        summary: "Upload validation is patched.",
        openWork: ["Run upload integration tests."],
        blockers: [],
        verifiedFacts: ["Upload route validates MIME type."],
        evidence: ["upload-server.ts"],
        nextStep: "Run upload integration tests.",
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Read upload server implementation.",
        newFacts: ["Upload route validates MIME type."],
        artifacts: ["ayati-main/src/server/upload-server.ts"],
        toolsUsed: ["read_file"],
        evidenceSummary: "read upload-server.ts lines 1-80",
        evidenceItems: ["upload-server.ts: validates MIME type"],
      }, {
        step: 2,
        outcome: "failed",
        summary: "Tried a missing upload test path.",
        newFacts: [],
        artifacts: [],
        toolsUsed: ["read_file"],
      }],
      taskAssets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
    };

    const mapped = buildGitMemoryTaskRunCommitInput({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      result,
      conversationRefs: [{ fromSeq: 3, toSeq: 4 }],
      startedAt: "2026-06-28T09:00:00+05:30",
      at: "2026-06-28T09:10:00+05:30",
    });

    expect(mapped).toMatchObject({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      runId: "R-20260628-0001",
      status: "completed",
      startedAt: "2026-06-28T09:00:00+05:30",
      completedAt: "2026-06-28T09:10:00+05:30",
      conversationRefs: [{ fromSeq: 3, toSeq: 4 }],
      summary: "Patched upload validation.",
      assistantResponse: "I fixed the upload validation mismatch.",
      toolCallCount: 3,
      changedFiles: ["ayati-main/src/server/upload-server.ts"],
      assets: [{
        assetId: "asset-upload-log",
        role: "reference",
        kind: "file",
        name: "upload.log",
        path: "/tmp/upload.log",
      }],
      newFacts: [
        "Upload route validates MIME type.",
        "Uploads pass through the multipart parser.",
      ],
      next: "Run upload integration tests.",
      state: {
        status: "in_progress",
        summary: "Upload validation is patched.",
        completed: [
          "Identified the validation path.",
          "Read upload server implementation.",
        ],
        open: ["Run upload integration tests."],
        blockers: [],
        next: "Run upload integration tests.",
      },
    });
    expect(mapped.actions).toMatchObject([{
      tool: "read_file",
      status: "completed",
      summary: "Read upload server implementation.",
    }, {
      tool: "read_file",
      status: "failed",
      summary: "Tried a missing upload test path.",
    }]);
    expect(mapped.evidence).toMatchObject([{
      step: 1,
      tool: "read_file",
      status: "completed",
      summary: "Read upload server implementation.",
      evidenceRef: "read upload-server.ts lines 1-80",
      artifacts: ["ayati-main/src/server/upload-server.ts"],
      facts: [
        "Upload route validates MIME type.",
        "upload-server.ts: validates MIME type",
      ],
      accessModes: ["summary"],
      source: { kind: "harness-step" },
    }, {
      step: 2,
      tool: "read_file",
      status: "failed",
      summary: "Tried a missing upload test path.",
      artifacts: [],
      facts: [],
      accessModes: [],
      source: { kind: "harness-step" },
    }]);
  });

  it("maps feedback runs to needs-user-input run status and blocked task state", () => {
    const mapped = buildGitMemoryTaskRunCommitInput({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      result: {
        type: "feedback",
        status: "completed",
        content: "Which upload format should I support first?",
        totalIterations: 1,
        totalToolCalls: 0,
        runPath: "data/runs/r2",
        workState: {
          status: "needs_user_input",
          summary: "Need user priority before changing upload formats.",
          openWork: ["Wait for upload format priority."],
          blockers: [],
          verifiedFacts: [],
          evidence: [],
          userInputNeeded: "Choose the first upload format to support.",
        },
      },
      conversationRefs: [{ fromSeq: 5, toSeq: 5 }],
      at: "2026-06-28T10:00:00+05:30",
    });

    expect(mapped).toMatchObject({
      status: "needs_user_input",
      state: {
        status: "blocked",
        blockers: ["Choose the first upload format to support."],
        open: ["Wait for upload format priority."],
      },
    });
  });
});
