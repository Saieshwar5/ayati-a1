import { describe, it, expect } from "vitest";
import { AgentWorkingMemory } from "../../src/memory/agent-working-memory.js";

describe("AgentWorkingMemory", () => {
  it("starts empty", () => {
    const wm = new AgentWorkingMemory("run-1");
    expect(wm.plan).toBeNull();
    expect(wm.steps).toHaveLength(0);
    expect(wm.errorRegister).toHaveLength(0);
    expect(wm.keyFacts).toHaveLength(0);
  });

  it("setPlan stores plan at version 1", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Fix auth bug",
      sub_tasks: [
        { id: 1, title: "Read auth.ts", status: "pending" },
        { id: 2, title: "Apply fix", status: "pending", depends_on: [1] },
      ],
      current_sub_task: 1,
      plan_version: 1,
    });
    expect(wm.plan?.goal).toBe("Fix auth bug");
    expect(wm.plan?.plan_version).toBe(1);
    expect(wm.plan?.sub_tasks).toHaveLength(2);
  });

  it("updateSubTaskStatus marks sub-task done", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Test",
      sub_tasks: [
        { id: 1, title: "Task 1", status: "pending" },
        { id: 2, title: "Task 2", status: "pending", depends_on: [1] },
      ],
      current_sub_task: 1,
      plan_version: 1,
    });

    wm.updateSubTaskStatus(1, "done");
    expect(wm.plan?.sub_tasks[0]?.status).toBe("done");
    expect(wm.plan?.sub_tasks[1]?.status).toBe("pending");
  });

  it("advanceToNextSubTask respects depends_on", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Test",
      sub_tasks: [
        { id: 1, title: "Task 1", status: "pending" },
        { id: 2, title: "Task 2", status: "pending", depends_on: [1] },
        { id: 3, title: "Task 3", status: "pending" },
      ],
      current_sub_task: 1,
      plan_version: 1,
    });

    // Mark task 1 as done — now task 2 (depends on 1) and task 3 (no deps) are eligible.
    // Task 1 is first in array but now done, task 2 is first eligible pending → returns 2.
    wm.updateSubTaskStatus(1, "done");
    const next = wm.advanceToNextSubTask();
    expect(next).toBe(2);
    expect(wm.plan?.current_sub_task).toBe(2);
    expect(wm.plan?.sub_tasks[1]?.status).toBe("in_progress");
  });

  it("advanceToNextSubTask skips tasks with unmet deps", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Test",
      sub_tasks: [
        { id: 1, title: "Task 1", status: "done" },
        { id: 2, title: "Task 2", status: "done" },
        { id: 3, title: "Task 3", status: "pending", depends_on: [4] },
        { id: 4, title: "Task 4", status: "pending" },
      ],
      current_sub_task: 2,
      plan_version: 1,
    });

    // Task 3 depends on task 4 (not done). Task 4 has no deps. Should return 4.
    const next = wm.advanceToNextSubTask();
    expect(next).toBe(4);
    expect(wm.plan?.current_sub_task).toBe(4);
  });

  it("advanceToNextSubTask returns null when all sub-tasks are done", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Test",
      sub_tasks: [{ id: 1, title: "Task 1", status: "done" }],
      current_sub_task: 1,
      plan_version: 1,
    });

    const next = wm.advanceToNextSubTask();
    expect(next).toBeNull();
  });

  it("addStep records steps", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addStep({ step: 1, phase: "reason", thinking: "Thinking", summary: "Plan approach" });
    wm.addStep({ step: 2, phase: "act", thinking: "Acting", summary: "Read file", toolName: "read_file", toolOutput: "content", toolStatus: "success" });

    expect(wm.steps).toHaveLength(2);
    expect(wm.steps[0]?.phase).toBe("reason");
    expect(wm.steps[1]?.toolName).toBe("read_file");
    expect(wm.steps[1]?.toolOutput).toBe("content");
  });

  it("addError and resolveError work correctly", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addError({ step: 2, toolName: "shell", errorMessage: "not found", resolved: false });

    expect(wm.errorRegister).toHaveLength(1);
    expect(wm.errorRegister[0]?.resolved).toBe(false);

    wm.resolveError(2, "Used different path");
    expect(wm.errorRegister[0]?.resolved).toBe(true);
    expect(wm.errorRegister[0]?.resolutionSummary).toBe("Used different path");
  });

  it("addKeyFacts stores facts", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addKeyFacts([
      { fact: "Port is 3000", sourceStep: 3, sourceToolName: "read_file" },
      { fact: "DB is postgres", sourceStep: 3 },
    ]);
    expect(wm.keyFacts).toHaveLength(2);
    expect(wm.keyFacts[0]?.fact).toBe("Port is 3000");
  });

  it("renderView shows [PLAN] section when plan exists", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.setPlan({
      goal: "Migrate auth to JWT",
      sub_tasks: [
        { id: 1, title: "Audit auth code", status: "done" },
        { id: 2, title: "Create JWT utils", status: "in_progress" },
        { id: 3, title: "Update tests", status: "pending", depends_on: [2] },
      ],
      current_sub_task: 2,
      plan_version: 1,
    });

    const view = wm.renderView();
    expect(view).toContain("[PLAN v1]");
    expect(view).toContain("Migrate auth to JWT");
    expect(view).toContain("✓ Sub-task 1");
    expect(view).toContain("→ Sub-task 2");
    expect(view).toContain("○ Sub-task 3");
    expect(view).toContain("CURRENT");
  });

  it("renderView shows [Key Facts] when facts exist", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addKeyFacts([{ fact: "auth.ts uses express-session", sourceStep: 3, sourceToolName: "read_file" }]);
    wm.addStep({ step: 3, phase: "verify", thinking: "t", summary: "s" });

    const view = wm.renderView();
    expect(view).toContain("[Key Facts]");
    expect(view).toContain("auth.ts uses express-session");
    expect(view).toContain("[step 3");
  });

  it("renderView shows (none) in [Errors] when no errors", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addStep({ step: 1, phase: "reason", thinking: "t", summary: "s" });

    const view = wm.renderView();
    expect(view).toContain("[Errors]");
    expect(view).toContain("(none)");
  });

  it("renderView shows unresolved and resolved errors correctly", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addError({ step: 2, toolName: "shell", errorMessage: "permission denied", resolved: false });
    wm.addError({ step: 4, toolName: "edit_file", errorMessage: "file not found", resolved: true, resolutionSummary: "created file first" });
    wm.addStep({ step: 1, phase: "reason", thinking: "t", summary: "s" });

    const view = wm.renderView();
    expect(view).toContain("✗ [Step 2]");
    expect(view).toContain("permission denied");
    expect(view).toContain("✓ [Step 4]");
    expect(view).toContain("created file first");
  });

  it("renderView includes full tool output in steps (no truncation)", () => {
    const wm = new AgentWorkingMemory("run-1");
    const longOutput = "x".repeat(2000);
    wm.addStep({
      step: 1,
      phase: "act",
      thinking: "t",
      summary: "Read large file",
      toolName: "read_file",
      toolOutput: longOutput,
      toolStatus: "success",
    });

    const view = wm.renderView();
    expect(view).toContain(longOutput);
    expect(view.length).toBeGreaterThan(2000);
  });

  it("renderView includes context signals when provided", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addStep({ step: 1, phase: "reason", thinking: "t", summary: "s" });

    const view = wm.renderView("ℹ 5 of 14 steps used\n⚠ 3 steps without action.");
    expect(view).toContain("[Context Signals]");
    expect(view).toContain("5 of 14 steps used");
    expect(view).toContain("3 steps without action.");
  });

  it("renderView omits [PLAN] and [Key Facts] sections when empty", () => {
    const wm = new AgentWorkingMemory("run-1");
    wm.addStep({ step: 1, phase: "reason", thinking: "t", summary: "Simple task" });

    const view = wm.renderView();
    expect(view).not.toContain("[PLAN");
    expect(view).not.toContain("[Key Facts]");
    expect(view).toContain("[Steps]");
  });
});
