import { describe, expect, it } from "vitest";
import { auditToolPolicy } from "../../src/ivec/agent-runner/tool-policy-audit.js";
import type {
  RuntimeCapabilityMode,
  RuntimeCapabilityModeName,
} from "../../src/ivec/agent-runner/runtime-capability-mode.js";

describe("tool policy audit", () => {
  it("allows read-only tools during session enquiry", () => {
    const audit = auditToolPolicy({
      mode: mode("session_only"),
      selectedTools: ["read_files", "git_context_read_task"],
    });

    expect(audit.phase).toBe("enquiry");
    expect(audit.violations).toEqual([]);
    expect(audit.warningCodes).toEqual([]);
  });

  it("flags task-run-only mutation tools before a work run exists", () => {
    const audit = auditToolPolicy({
      mode: mode("session_only"),
      selectedTools: ["write_files", "shell_session_start"],
    });

    expect(audit.warningCodes).toEqual([
      "mutation_tool_without_task_run",
      "tool_not_allowed_in_phase",
      "long_running_tool_without_task_run",
    ]);
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "mutation_tool_without_task_run",
        severity: "error",
        tools: ["write_files", "shell_session_start"],
      }),
      expect.objectContaining({
        code: "long_running_tool_without_task_run",
        severity: "error",
        tools: ["shell_session_start"],
      }),
      expect.objectContaining({
        code: "tool_not_allowed_in_phase",
        severity: "warning",
        tools: ["write_files", "shell_session_start"],
      }),
    ]));
  });

  it("allows routing mutations during routing mode", () => {
    const audit = auditToolPolicy({
      mode: mode("fresh_session_routing"),
      selectedTools: ["git_context_create_task_for_turn"],
    });

    expect(audit.phase).toBe("routing");
    expect(audit.violations).toEqual([]);
  });

  it("allows routing mutations during the active-task routing window", () => {
    const audit = auditToolPolicy({
      mode: {
        ...mode("active_task_ready"),
        routingWindow: {
          open: true,
          step: 1,
          maxSteps: 2,
          remaining: 1,
          expiresAfterThisDecision: false,
          readToolsAvailable: true,
          routingToolsAvailable: true,
          readToolsRemainAfterExpiry: true,
          guidance: "test routing window",
        },
      },
      selectedTools: ["write_files", "git_context_create_task_for_turn"],
    });

    expect(audit.phase).toBe("task_run");
    expect(audit.violations).toEqual([]);
  });

  it("flags routing mutations after task work is bound", () => {
    const audit = auditToolPolicy({
      mode: mode("task_run", true, "bound"),
      selectedTools: ["git_context_create_task_for_turn", "git_context_read_task"],
    });

    expect(audit.phase).toBe("task_run");
    expect(audit.warningCodes).toEqual([
      "routing_mutation_after_task_bound",
      "tool_not_allowed_in_phase",
    ]);
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "routing_mutation_after_task_bound",
        severity: "error",
        tools: ["git_context_create_task_for_turn"],
      }),
      expect.objectContaining({
        code: "tool_not_allowed_in_phase",
        severity: "warning",
        tools: ["git_context_create_task_for_turn"],
      }),
    ]));
  });

  it("flags selected tools missing taxonomy", () => {
    const audit = auditToolPolicy({
      mode: mode("task_run", true),
      selectedTools: ["unknown_tool"],
    });

    expect(audit.taxonomy.unknown).toEqual(["unknown_tool"]);
    expect(audit.warningCodes).toEqual(["unknown_tool_taxonomy"]);
    expect(audit.violations).toEqual([
      expect.objectContaining({
        code: "unknown_tool_taxonomy",
        severity: "error",
        tools: ["unknown_tool"],
      }),
    ]);
  });
});

function mode(
  name: RuntimeCapabilityModeName,
  hasWorkRun = false,
  pendingTurnStatus?: string,
): RuntimeCapabilityMode {
  return {
    name,
    primary: true,
    hasWorkRun,
    ...(pendingTurnStatus ? { pendingTurnStatus } : {}),
    whyActive: "test mode",
    allowedActions: [],
    blockedCapabilities: [],
    next: "test next",
    allowToolLoading: true,
  };
}
