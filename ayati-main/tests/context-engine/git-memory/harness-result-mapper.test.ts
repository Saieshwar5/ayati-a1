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
        evidenceSource: {
          kind: "tool-output",
          toolCalls: [{
            kind: "tool-output",
            tool: "read_file",
            callId: "call-read-upload",
            filePath: "ayati-main/src/server/upload-server.ts",
            rawOutputPath: "raw/001-call-read-upload-read_file.txt",
          }],
        },
        outputSize: 1200,
        lineCount: 80,
        truncated: false,
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
      outputSize: 1200,
      lineCount: 80,
      truncated: false,
      source: {
        kind: "tool-output",
        toolCalls: [{
          kind: "tool-output",
          tool: "read_file",
          callId: "call-read-upload",
          filePath: "ayati-main/src/server/upload-server.ts",
          rawOutputPath: "raw/001-call-read-upload-read_file.txt",
        }],
      },
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

  it("maps feedback runs to needs-user-input run status and task state", () => {
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
      next: "Choose the first upload format to support.",
      state: {
        status: "needs_user_input",
        blockers: [],
        open: ["Wait for upload format priority."],
        next: "Choose the first upload format to support.",
      },
    });
  });

  it("does not map routing-only completed runs to done", () => {
    const mapped = buildGitMemoryTaskRunCommitInput({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      result: {
        type: "reply",
        status: "completed",
        content: "I created the markdown helper.",
        totalIterations: 3,
        totalToolCalls: 1,
        runPath: "data/runs/r-routing-only",
        taskSummary: {
          taskStatus: "done",
          summary: "I created the markdown helper.",
          completedMilestones: ["Pending-turn routing tools executed successfully."],
          openWork: [],
          nextAction: "No next step.",
        },
        completedSteps: [{
          step: 1,
          outcome: "success",
          summary: "Pending-turn routing tools executed successfully.",
          newFacts: ["Pending-turn routing tools executed successfully."],
          artifacts: [],
          toolsUsed: ["git_context_create_task_for_turn"],
          evidenceSummary: "git_context_create_task_for_turn: Pending turn created a new git-context task.",
          toolSuccessCount: 1,
          toolFailureCount: 0,
        }],
      },
      conversationRefs: [{ fromSeq: 9, toSeq: 9 }],
      at: "2026-06-28T11:00:00+05:30",
    });

    expect(mapped).toMatchObject({
      status: "blocked",
      summary: "I created the markdown helper.",
      state: {
        status: "blocked",
        summary: "Task run stopped without durable work evidence.",
        open: ["Retry or continue the task with concrete work."],
        blockers: ["The run completed with only git-context routing work."],
        next: "Retry or continue the task with concrete work.",
      },
      next: "Retry or continue the task with concrete work.",
    });
  });

  it("maps failed runs to failed run status and blocked task state", () => {
    const mapped = buildGitMemoryTaskRunCommitInput({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      result: {
        type: "reply",
        status: "failed",
        content: "The upload test command failed.",
        totalIterations: 2,
        totalToolCalls: 1,
        runPath: "data/runs/r3",
        workState: {
          status: "blocked",
          summary: "Upload verification failed.",
          openWork: ["Debug the failing upload test."],
          blockers: ["Upload test command exited non-zero."],
          verifiedFacts: ["The upload test command was attempted."],
          evidence: ["pnpm upload test output"],
          nextStep: "Inspect the failing upload test output.",
        },
      },
      conversationRefs: [{ fromSeq: 6, toSeq: 6 }],
      at: "2026-06-28T10:10:00+05:30",
    });

    expect(mapped).toMatchObject({
      status: "failed",
      newFacts: ["The upload test command was attempted."],
      next: "Inspect the failing upload test output.",
      state: {
        status: "blocked",
        summary: "Upload verification failed.",
        open: ["Debug the failing upload test."],
        blockers: ["Upload test command exited non-zero."],
        next: "Inspect the failing upload test output.",
      },
    });
  });

  it("maps stuck runs to blocked run status and blocked task state", () => {
    const mapped = buildGitMemoryTaskRunCommitInput({
      sessionId: "S-20260628-local",
      taskId: "W-20260628-0001",
      result: {
        type: "reply",
        status: "stuck",
        content: "I could not make more progress without resolving the branch state.",
        totalIterations: 3,
        totalToolCalls: 2,
        runPath: "data/runs/r4",
        taskSummary: {
          taskStatus: "blocked",
          summary: "Branch state needs cleanup before continuing.",
          openWork: ["Resolve the branch state."],
          blockers: ["The branch has conflicting task ownership."],
          nextAction: "Decide which task branch should own this work.",
        },
      },
      conversationRefs: [{ fromSeq: 7, toSeq: 7 }],
      at: "2026-06-28T10:20:00+05:30",
    });

    expect(mapped).toMatchObject({
      status: "blocked",
      next: "Decide which task branch should own this work.",
      state: {
        status: "blocked",
        summary: "Branch state needs cleanup before continuing.",
        open: ["Resolve the branch state."],
        blockers: ["The branch has conflicting task ownership."],
        next: "Decide which task branch should own this work.",
      },
    });
  });
});
