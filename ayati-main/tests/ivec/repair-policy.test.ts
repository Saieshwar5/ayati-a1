import { describe, expect, it } from "vitest";
import {
  createRepairSignal,
  REPAIR_CODE_CATALOG,
  REPAIR_CODES,
  repairSignalToFeedbackData,
  repairSignalToPromptCard,
  repairSignalToPromptText,
} from "../../src/ivec/agent-runner/repair-policy.js";

describe("repair policy", () => {
  it("has a catalog entry for every repair code", () => {
    expect(Object.keys(REPAIR_CODE_CATALOG).sort()).toEqual([...REPAIR_CODES].sort());
    for (const code of REPAIR_CODES) {
      expect(REPAIR_CODE_CATALOG[code]).toMatchObject({
        code,
        severity: expect.any(String),
        source: expect.any(String),
        message: expect.any(String),
        allowedNextActions: expect.any(Array),
        modelFacing: expect.any(Boolean),
      });
      expect(REPAIR_CODE_CATALOG[code].allowedNextActions.length).toBeGreaterThan(0);
    }
    expect(REPAIR_CODE_CATALOG.R_LOAD_TOOLS_USED_AS_ACTION.allowedNextActions).toContain(
      "Use the native decision_load_tools control tool.",
    );
    expect(REPAIR_CODE_CATALOG.R_LOAD_TOOLS_USED_AS_ACTION.allowedNextActions).not.toContain(
      "Do not put load_tools in executable action calls.",
    );
  });

  it("creates a repair signal with catalog defaults and compact detail fields", () => {
    const signal = createRepairSignal("R_FRESH_SESSION_NEEDS_TASK", {
      blockedTargets: [" write_files ", "write_files", "", " process_run  "],
      operatorDetails: {
        seq: 31,
        selectedTools: ["write_files"],
      },
    });

    expect(signal).toMatchObject({
      code: "R_FRESH_SESSION_NEEDS_TASK",
      severity: "repairable",
      source: "runner.guard",
      message: "No active task exists yet. Normal work tools cannot run before task binding.",
      blockedTargets: ["write_files", "process_run"],
      missingFields: [],
      invalidFields: [],
      modelFacing: true,
      operatorDetails: {
        seq: 31,
        selectedTools: ["write_files"],
      },
    });
    expect(signal.allowedNextActions).toEqual([
      "Inspect the task candidates in context and call git_context_activate_task for an exact matching task.",
      "Call git_context_create_task with title, objective, and reason for distinct new durable work.",
      "Ask a short clarification directly if the request is unclear.",
    ]);
  });

  it("allows callers to override source, message, severity, and allowed next actions", () => {
    const signal = createRepairSignal("R_TOOL_INPUT_MISSING_REQUIRED_FIELD", {
      severity: "error",
      source: "decision.input_schema.native",
      message: "Missing required fields for git_context_create_task.",
      missingFields: ["title", "objective", "createReason"],
      allowedNextActions: ["Call git_context_create_task again with title, objective, and createReason."],
    });

    expect(signal).toMatchObject({
      code: "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
      severity: "error",
      source: "decision.input_schema.native",
      message: "Missing required fields for git_context_create_task.",
      missingFields: ["title", "objective", "createReason"],
      allowedNextActions: ["Call git_context_create_task again with title, objective, and createReason."],
    });
  });

  it("formats a compact model-facing prompt card", () => {
    const signal = createRepairSignal("R_TOOL_INPUT_MISSING_REQUIRED_FIELD", {
      blockedTargets: ["git_context_create_task"],
      missingFields: ["title", "objective", "createReason"],
      operatorDetails: {
        attempt: 1,
        inputKeys: ["taskCompletion"],
      },
    });

    expect(repairSignalToPromptCard(signal)).toEqual({
      code: "R_TOOL_INPUT_MISSING_REQUIRED_FIELD",
      message: "The selected tool input is missing required fields.",
      blockedTargets: ["git_context_create_task"],
      missingFields: ["title", "objective", "createReason"],
      allowedNextActions: ["Call the selected tool again with the missing required fields."],
    });

    const promptText = repairSignalToPromptText(signal);
    expect(promptText).toContain("Repair code: R_TOOL_INPUT_MISSING_REQUIRED_FIELD");
    expect(promptText).toContain("Missing fields: title, objective, createReason");
    expect(promptText).not.toContain("operatorDetails");
    expect(promptText).not.toContain("taskCompletion");
  });

  it("keeps operator details in feedback data", () => {
    const signal = createRepairSignal("R_ASSISTANT_TEXT_TOOL_CALL", {
      blockedTargets: ["git_context_create_task"],
      operatorDetails: {
        attempt: 1,
        toolName: "git_context_create_task",
        inputKeys: ["taskCompletion"],
      },
    });

    expect(repairSignalToFeedbackData(signal)).toEqual({
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        severity: "repairable",
        source: "decision.assistant_text",
        message: "The assistant response looked like a tool call written as text.",
        modelFacing: true,
        blockedTargets: ["git_context_create_task"],
        missingFields: [],
        invalidFields: [],
        allowedNextActions: [
          "Do not write tool-call JSON in assistant text.",
          "If tool work is needed, call exactly one available native tool directly.",
          "Use direct assistant text only for a user-facing reply.",
        ],
        operatorDetails: {
          attempt: 1,
          toolName: "git_context_create_task",
          inputKeys: ["taskCompletion"],
        },
      },
    });
  });

  it("does not create model prompt cards for operator-only repairs", () => {
    const signal = createRepairSignal("R_PROVIDER_EMPTY_RESPONSE", {
      operatorDetails: {
        provider: "openrouter",
        model: "test-model",
        choiceCount: 0,
      },
    });

    expect(signal.modelFacing).toBe(false);
    expect(repairSignalToPromptCard(signal)).toBeUndefined();
    expect(repairSignalToPromptText(signal)).toBeUndefined();
    expect(repairSignalToFeedbackData(signal).repair.operatorDetails).toMatchObject({
      provider: "openrouter",
      model: "test-model",
      choiceCount: 0,
    });
  });
});
