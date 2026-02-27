import { describe, it, expect } from "vitest";
import { checkVerificationGates } from "../../src/ivec/verification-gates.js";
import type { ActOutput } from "../../src/ivec/types.js";

describe("checkVerificationGates", () => {
  it("returns passed: false when all tool calls fail", () => {
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

  it("returns passed: true when all tool calls succeed with output (gate 3)", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "hello" },
        { tool: "read", input: {}, output: "content" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.method).toBe("gate");
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

  it("returns passed: true when mixed but useful output exists", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "ok" },
        { tool: "read", input: {}, output: "", error: "file not found" },
      ],
      finalText: "",
    };
    const result = checkVerificationGates(actOutput, "should succeed");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  it("returns passed: false when mixed has critical blocker", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "shell", input: {}, output: "ok" },
        { tool: "read", input: {}, output: "", error: "permission denied" },
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

  it("returns passed: false for discovery criteria when output has no matches", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "find_files", input: { query: "learn1.go" }, output: "(no matches)" },
      ],
      finalText: "",
    };

    const result = checkVerificationGates(actOutput, "Find and return the file path");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.evidence.toLowerCase()).toContain("no matches");
  });

  it("allows no-match output when criteria explicitly asks to confirm absence", () => {
    const actOutput: ActOutput = {
      toolCalls: [
        { tool: "find_files", input: { query: "learn1.go" }, output: "(no matches)" },
      ],
      finalText: "",
    };

    const result = checkVerificationGates(actOutput, "Confirm the file does not exist");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });
});
