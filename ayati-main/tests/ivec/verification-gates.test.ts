import { describe, it, expect } from "vitest";
import { checkVerificationGates } from "../../src/ivec/verification-gates.js";
import type { ActOutput } from "../../src/ivec/types.js";

describe("checkVerificationGates", () => {
  it("returns passed: false when any tool call has error", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "", error: "command not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.method).toBe("gate");
    expect(result!.evidence).toContain("command not found");
  });

  it("returns null when all tool calls succeed (falls through to LLM verify)", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "hello" },
        { tool: "read", input: {}, output: "content" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).toBeNull();
  });

  it("returns passed: true when no tools but text present", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "Here is your answer.",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  it("returns passed: false when mixed (some error)", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "ok" },
        { tool: "read", input: {}, output: "", error: "file not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
  });

  it("returns null for empty act output (no tools, no text)", () => {
    const actOutput: ActOutput = {
      toolCalls: [],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).toBeNull();
  });
});
