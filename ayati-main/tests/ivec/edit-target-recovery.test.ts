import { describe, expect, it } from "vitest";
import { buildStepSummary } from "../../src/ivec/agent-runner/step-lifecycle.js";
import { createFailureRecordFromStepSummary, createRepairSignalFromStepSummary } from "../../src/ivec/agent-runner/repair-feedback.js";
import type { AgentAction } from "../../src/ivec/agent-runner/decision.js";
import type { AgentActionExecutionResult } from "../../src/ivec/agent-runner/action-executor.js";
import type { StepSummary } from "../../src/ivec/types.js";

describe("edit target recovery policy", () => {
  it("preserves compact edit diagnostics in step evidence source", () => {
    const step = buildStepSummary({
      stepNumber: 3,
      action: actionFor("patch_files"),
      execution: failedPatchExecution(),
    });

    expect(step.evidenceSource).toMatchObject({
      kind: "tool-output",
      toolCalls: [{
        tool: "patch_files",
        status: "failed",
        code: "PATCH_TARGET_NOT_FOUND",
        filePath: "/tmp/styles.css",
        patchIndex: 0,
        operationKind: "replace_text",
        diagnostic: {
          targetKind: "find text",
          matchStrategy: "whitespace_normalized",
          nearestMatchLine: 142,
        },
      }],
    });
  });

  it("creates a model-facing recovery repair from edit target diagnostics", () => {
    const step: StepSummary = {
      ...baseFailedStep(),
      evidenceSource: {
        kind: "tool-output",
        toolCalls: [{
          tool: "patch_files",
          status: "failed",
          code: "PATCH_TARGET_NOT_FOUND",
          filePath: "/tmp/styles.css",
          patchIndex: 0,
          kind: "replace_text",
          diagnostic: {
            targetKind: "find text",
            reason: "Exact find text was not found, but a whitespace-normalized match exists.",
            hint: "Retry with the exact multiline text from nearestMatchPreview.",
            nearestMatchLine: 142,
            nearestMatchPreview: ".habit-item.done-today {\n  background: var(--success-bg);\n}",
            matchStrategy: "whitespace_normalized",
          },
        }],
      },
    };

    const repair = createRepairSignalFromStepSummary(step);
    expect(repair).toMatchObject({
      code: "R_EDIT_TARGET_RECOVERY",
      blockedTargets: ["patch_files", "/tmp/styles.css"],
    });
    expect(repair?.allowedNextActions.join("\n")).toContain("read_files");
    expect(repair?.allowedNextActions.join("\n")).toContain("startLine=139");
    expect(repair?.allowedNextActions.join("\n")).toContain("replace_lines");

    const failure = createFailureRecordFromStepSummary(step);
    expect(failure.repairCode).toBe("R_EDIT_TARGET_RECOVERY");
    expect(failure.repair?.allowedNextActions.join("\n")).toContain("Do not retry the same stale target string.");
  });

  it("escalates repeated edit target recovery on the same file to guarded rewrite", () => {
    const firstStep: StepSummary = {
      ...baseFailedStep(),
      step: 4,
      evidenceSource: patchFailureEvidence("/tmp/styles.css", 142),
    };
    const first = createFailureRecordFromStepSummary(firstStep);

    const secondStep: StepSummary = {
      ...baseFailedStep(),
      step: 5,
      evidenceSource: patchFailureEvidence("/tmp/styles.css", 142),
    };
    const second = createFailureRecordFromStepSummary(secondStep, [first]);

    expect(first.repairCode).toBe("R_EDIT_TARGET_RECOVERY");
    expect(second.repairCode).toBe("R_EDIT_ESCALATE_TO_GUARDED_REWRITE");
    expect(second.repair?.allowedNextActions.join("\n")).toContain("files=[{path:");
    expect(second.repair?.allowedNextActions.join("\n")).toContain("mode:\"full\"");
    expect(second.repair?.allowedNextActions.join("\n")).toContain("baseSha256");
    expect(second.repair?.allowedNextActions.join("\n")).toContain("Do not use shell mutation.");
  });
});

function actionFor(tool: string): AgentAction {
  return {
    mode: "single",
    allowedTools: [tool],
    calls: [{
      id: "call_1",
      tool,
      input: {},
      dependsOn: [],
    }],
    assertions: [],
  };
}

function failedPatchExecution(): AgentActionExecutionResult {
  return {
    actOutput: {
      finalText: "",
      toolCalls: [{
        tool: "patch_files",
        input: {},
        output: "",
        error: "find text not found in file.",
        code: "PATCH_TARGET_NOT_FOUND",
        result: {
          transportOk: true,
          operationStatus: "failed",
          code: "PATCH_TARGET_NOT_FOUND",
          message: "find text not found in file.",
          structuredContent: {
            filePath: "/tmp/styles.css",
            patchIndex: 0,
            kind: "replace_text",
            diagnostic: {
              targetKind: "find text",
              matchStrategy: "whitespace_normalized",
              nearestMatchLine: 142,
              hint: "Retry with exact multiline text.",
            },
          },
          error: {
            category: "semantic",
            code: "PATCH_TARGET_NOT_FOUND",
            message: "find text not found in file.",
            retryable: true,
            recoverable: true,
            target: "/tmp/styles.css",
            suggestedNextActions: [],
          },
        },
      }],
    },
    verifyOutput: {
      passed: false,
      method: "execution_gate",
      executionStatus: "all_failed",
      validationStatus: "skipped",
      summary: "patch_files: find text not found in file.",
      evidenceSummary: "patch_files failed.",
      evidenceItems: ["patch_files: find text not found in file."],
      newFacts: [],
      artifacts: [],
      usedRawArtifacts: [],
    },
    nextWorkState: {
      status: "not_done",
      summary: "",
      verifiedFacts: [],
      evidence: [],
    },
  };
}

function baseFailedStep(): StepSummary {
  return {
    step: 4,
    executionContract: "single action: patch_files",
    outcome: "failed",
    summary: "patch_files: find text not found in file.",
    newFacts: [],
    artifacts: [],
    toolsUsed: ["patch_files"],
    toolSuccessCount: 0,
    toolFailureCount: 1,
    evidenceItems: ["patch_files: find text not found in file."],
    failureType: "tool_error",
    blockedTargets: ["/tmp/styles.css"],
  };
}

function patchFailureEvidence(filePath: string, nearestMatchLine: number): Record<string, unknown> {
  return {
    kind: "tool-output",
    toolCalls: [{
      tool: "patch_files",
      status: "failed",
      code: "PATCH_TARGET_NOT_FOUND",
      filePath,
      patchIndex: 0,
      operationKind: "replace_text",
      diagnostic: {
        targetKind: "find text",
        reason: "Exact find text was not found, but a whitespace-normalized match exists.",
        hint: "Retry with the exact multiline text from nearestMatchPreview.",
        nearestMatchLine,
        nearestMatchPreview: ".habit-item.done-today {\n  background: var(--success-bg);\n}",
        matchStrategy: "whitespace_normalized",
      },
    }],
  };
}
