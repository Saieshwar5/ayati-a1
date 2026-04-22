import { describe, it, expect } from "vitest";
import { checkVerificationGates } from "../../src/ivec/verification-gates.js";
import type { ActOutput } from "../../src/ivec/types.js";

describe("checkVerificationGates", () => {
  it("returns an execution failure when all tool calls fail", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "", error: "command not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.method).toBe("execution_gate");
    expect(result!.executionStatus).toBe("all_failed");
    expect(result!.validationStatus).toBe("skipped");
    expect(result!.evidenceSummary).toContain("command not found");
  });

  it("returns null when execution succeeded and LLM validation should decide", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "hello" },
        { tool: "read", input: {}, output: "content" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns null when no tools ran but assistant text exists for validation", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "Here is your answer.",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns null when there is partial execution success", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "ok" },
        { tool: "read", input: {}, output: "", error: "file not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });

  it("returns an execution failure for empty act output", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.executionStatus).toBe("no_tools");
    expect(result!.validationStatus).toBe("skipped");
  });

  it("does not make content-judgment decisions like discovery success or failure", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "find_files", input: { query: "learn1.go" }, output: "(no matches)" },
      ],
      finalText: "",
    };

    const result = checkVerificationGates(actOutput);
    expect(result).toBeNull();
  });
});
