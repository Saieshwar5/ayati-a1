import { describe, expect, it } from "vitest";
import type { ValidationCheckResult } from "../../src/ivec/agent-runner/task-validation-contracts.js";
import { completeWorkStateHandoff } from "../../src/ivec/agent-runner/work-state/terminal-handoff.js";
import type { WorkState } from "../../src/ivec/agent-runner/work-state/contracts.js";

describe("terminal WorkState handoff", () => {
  it("uses a compact operational summary for a simple direct response", () => {
    const result = completeWorkStateHandoff({
      runId: "RUN-DIRECT",
      workState: initialWorkState(),
      validationChecks: [],
    });

    expect(result).toEqual({
      status: "done",
      summary: "Completed the direct response.",
      plan: [],
      importantContext: [],
    });
  });

  it("derives a verified tool-run summary from completion receipts", () => {
    const result = completeWorkStateHandoff({
      runId: "RUN-READ",
      workState: initialWorkState(),
      validationChecks: [
        passedCheck("file.read_complete", "/workspace/story.txt", 2, "read-story"),
      ],
    });

    expect(result).toEqual({
      status: "done",
      summary: "Verified a complete read of /workspace/story.txt.",
      plan: [],
      importantContext: [{
        kind: "finding",
        value: "Verified a complete read of /workspace/story.txt.",
        ref: "run:RUN-READ:step:2:call:read-story",
      }],
    });
  });

  it("preserves a meaningful checkpoint while closing its plan and adding receipts", () => {
    const result = completeWorkStateHandoff({
      runId: "RUN-CHECKPOINT",
      workState: {
        status: "in_progress",
        summary: "Implemented the parser and prepared final validation.",
        plan: [{
          id: "parser",
          task: "Implement and validate the parser.",
          status: "active",
        }],
        importantContext: [{
          kind: "decision",
          value: "Keep the parser dependency-free.",
        }],
        nextAction: "Run final validation.",
      },
      validationChecks: [
        passedCheck("file.written", "/workspace/parser.ts", 4, "write-parser"),
      ],
    });

    expect(result).toMatchObject({
      status: "done",
      summary: "Implemented the parser and prepared final validation.",
      plan: [{
        id: "parser",
        task: "Implement and validate the parser.",
        status: "done",
      }],
      importantContext: [
        {
          kind: "decision",
          value: "Keep the parser dependency-free.",
        },
        {
          kind: "artifact",
          value: "Verified the written file /workspace/parser.ts.",
          ref: "run:RUN-CHECKPOINT:step:4:call:write-parser",
        },
      ],
    });
    expect(result.nextAction).toBeUndefined();
  });
});

function initialWorkState(): WorkState {
  return {
    status: "in_progress",
    summary: "Run started.",
    plan: [],
    importantContext: [],
  };
}

function passedCheck(
  kind: ValidationCheckResult["kind"],
  subject: string,
  step: number,
  callId: string,
): ValidationCheckResult {
  return {
    kind,
    subject,
    status: "passed",
    actualKind: "file",
    satisfiedBy: {
      step,
      callId,
      tool: kind === "file.read_complete" ? "read_files" : "write_files",
    },
  };
}
