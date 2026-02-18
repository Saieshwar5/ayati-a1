import { describe, it, expect } from "vitest";
import { parseAgentStep } from "../../src/ivec/agent-step-tool.js";

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

  it("parses a valid PLAN input", () => {
    const result = parseAgentStep({
      phase: "plan",
      thinking: "This is a complex task with multiple steps",
      summary: "Creating migration plan",
      plan: {
        goal: "Migrate auth to JWT",
        sub_tasks: [
          { id: 1, title: "Audit current code" },
          { id: 2, title: "Create JWT utils", depends_on: [1] },
        ],
      },
    });
    expect(result?.phase).toBe("plan");
    expect(result?.plan?.goal).toBe("Migrate auth to JWT");
    expect(result?.plan?.sub_tasks).toHaveLength(2);
    expect(result?.plan?.sub_tasks[1]?.depends_on).toEqual([1]);
  });

  it("returns null for PLAN without plan object", () => {
    const result = parseAgentStep({
      phase: "plan",
      thinking: "I need a plan",
      summary: "Planning",
    });
    expect(result).toBeNull();
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

  it("parses a valid VERIFY input with key_facts and sub_task_outcome", () => {
    const result = parseAgentStep({
      phase: "verify",
      thinking: "Checking output",
      summary: "Verify result",
      key_facts: ["Port is 3000", "DB is postgres"],
      sub_task_outcome: "done",
    });
    expect(result?.phase).toBe("verify");
    expect(result?.key_facts).toEqual(["Port is 3000", "DB is postgres"]);
    expect(result?.sub_task_outcome).toBe("done");
  });

  it("parses a valid VERIFY input with no optional fields", () => {
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

  it("parses a valid REFLECT input (no approaches_tried needed)", () => {
    const result = parseAgentStep({
      phase: "reflect",
      thinking: "That didn't work — wrong path. I should try /b instead.",
      summary: "Rethinking approach",
    });
    expect(result).toEqual({
      phase: "reflect",
      thinking: "That didn't work — wrong path. I should try /b instead.",
      summary: "Rethinking approach",
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
