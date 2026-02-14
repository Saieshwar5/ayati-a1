import { describe, it, expect } from "vitest";
import { parseAgentStep, buildScratchpadBlock } from "../../src/ivec/agent-step-tool.js";
import type { ScratchpadEntry } from "../../src/ivec/agent-loop-types.js";

describe("parseAgentStep", () => {
  it("parses a valid REASON input", () => {
    const result = parseAgentStep({
      phase: "reason",
      thinking: "I need to analyze the user request",
      summary: "Analyzing request",
    });
    expect(result).toEqual({
      phase: "reason",
      thinking: "I need to analyze the user request",
      summary: "Analyzing request",
    });
  });

  it("parses a valid ACT input with action", () => {
    const result = parseAgentStep({
      phase: "act",
      thinking: "Running shell command",
      summary: "Execute echo",
      action: { tool_name: "shell", tool_input: { cmd: "echo hi" } },
    });
    expect(result).toEqual({
      phase: "act",
      thinking: "Running shell command",
      summary: "Execute echo",
      action: { tool_name: "shell", tool_input: { cmd: "echo hi" } },
    });
  });

  it("returns null for ACT without action", () => {
    const result = parseAgentStep({
      phase: "act",
      thinking: "Running something",
      summary: "Do something",
    });
    expect(result).toBeNull();
  });

  it("parses a valid VERIFY input", () => {
    const result = parseAgentStep({
      phase: "verify",
      thinking: "Checking output",
      summary: "Verify result",
    });
    expect(result).toEqual({
      phase: "verify",
      thinking: "Checking output",
      summary: "Verify result",
    });
  });

  it("parses a valid REFLECT input with approaches_tried", () => {
    const result = parseAgentStep({
      phase: "reflect",
      thinking: "That didn't work",
      summary: "Reflecting on failure",
      approaches_tried: ["direct grep", "find command"],
    });
    expect(result).toEqual({
      phase: "reflect",
      thinking: "That didn't work",
      summary: "Reflecting on failure",
      approaches_tried: ["direct grep", "find command"],
    });
  });

  it("parses a valid FEEDBACK input", () => {
    const result = parseAgentStep({
      phase: "feedback",
      thinking: "I need clarification",
      summary: "Asking user",
      feedback_message: "Could you clarify what format you want?",
    });
    expect(result).toEqual({
      phase: "feedback",
      thinking: "I need clarification",
      summary: "Asking user",
      feedback_message: "Could you clarify what format you want?",
    });
  });

  it("returns null for FEEDBACK without feedback_message", () => {
    const result = parseAgentStep({
      phase: "feedback",
      thinking: "I need info",
      summary: "Asking",
    });
    expect(result).toBeNull();
  });

  it("parses a valid END input", () => {
    const result = parseAgentStep({
      phase: "end",
      thinking: "Task complete",
      summary: "Done",
      end_status: "solved",
      end_message: "Here is your answer.",
    });
    expect(result).toEqual({
      phase: "end",
      thinking: "Task complete",
      summary: "Done",
      end_status: "solved",
      end_message: "Here is your answer.",
    });
  });

  it("returns null for END without end_message", () => {
    const result = parseAgentStep({
      phase: "end",
      thinking: "Done",
      summary: "Ending",
      end_status: "solved",
    });
    expect(result).toBeNull();
  });

  it("defaults end_status to solved when missing", () => {
    const result = parseAgentStep({
      phase: "end",
      thinking: "Done",
      summary: "Ending",
      end_message: "Here you go",
    });
    expect(result?.end_status).toBe("solved");
  });

  it("returns null for invalid phase", () => {
    expect(parseAgentStep({ phase: "invalid", thinking: "x", summary: "x" })).toBeNull();
  });

  it("returns null for missing phase", () => {
    expect(parseAgentStep({ thinking: "x", summary: "x" })).toBeNull();
  });

  it("returns null for missing thinking", () => {
    expect(parseAgentStep({ phase: "reason", summary: "x" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseAgentStep(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseAgentStep("string")).toBeNull();
  });
});

describe("buildScratchpadBlock", () => {
  it("returns minimal block for empty entries", () => {
    const result = buildScratchpadBlock([], new Set());
    expect(result).toBe("[Scratchpad: empty]");
  });

  it("renders entries in order", () => {
    const entries: ScratchpadEntry[] = [
      { step: 1, phase: "reason", thinking: "t1", summary: "Analyzed request" },
      { step: 2, phase: "act", thinking: "t2", summary: "Ran command", toolResult: '{"ok":true}' },
    ];
    const result = buildScratchpadBlock(entries, new Set());
    expect(result).toContain("[Step 1] REASON: Analyzed request");
    expect(result).toContain("[Step 2] ACT: Ran command");
    expect(result).toContain('Result: {"ok":true}');
  });

  it("includes approaches", () => {
    const result = buildScratchpadBlock([], new Set(["grep approach", "find approach"]));
    expect(result).toContain("Approaches tried: grep approach, find approach");
  });

  it("truncates when entries exceed threshold", () => {
    const entries: ScratchpadEntry[] = Array.from({ length: 10 }, (_, i) => ({
      step: i + 1,
      phase: "reason" as const,
      thinking: `thinking ${i + 1}`,
      summary: `Summary ${i + 1}`,
    }));
    const result = buildScratchpadBlock(entries, new Set());
    expect(result).toContain("[Step 1] REASON: Summary 1");
    expect(result).toContain("[Step 2] REASON: Summary 2");
    expect(result).toContain("[Step 8] REASON: Summary 8");
    expect(result).toContain("[Step 9] REASON: Summary 9");
    expect(result).toContain("[Step 10] REASON: Summary 10");
    expect(result).toContain("5 intermediate steps omitted");
    expect(result).not.toContain("[Step 5] REASON: Summary 5");
  });

  it("truncates long tool results", () => {
    const longResult = "x".repeat(500);
    const entries: ScratchpadEntry[] = [
      { step: 1, phase: "act", thinking: "t", summary: "s", toolResult: longResult },
    ];
    const result = buildScratchpadBlock(entries, new Set());
    expect(result).toContain("...[truncated]");
  });
});
