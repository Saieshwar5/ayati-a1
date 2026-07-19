import { describe, expect, it } from "vitest";
import { auditToolPolicy } from "../../src/ivec/agent-runner/tool-policy-audit.js";
import type { WorkstreamBindingCapabilityPolicy } from "../../src/ivec/agent-runner/workstream-binding-capability-policy.js";

describe("tool policy audit", () => {
  it("allows observational tools on an unbound run", () => {
    const audit = auditToolPolicy({
      policy: policy({ routingAvailable: false }),
      selectedTools: ["read_files", "search_in_files"],
    });

    expect(audit.phase).toBe("enquiry");
    expect(audit.violations).toEqual([]);
  });

  it("flags mutation and long-running tools without a workstream binding", () => {
    const audit = auditToolPolicy({
      policy: policy(),
      selectedTools: ["write_files", "process_start"],
    });

    expect(audit.warningCodes).toEqual(expect.arrayContaining([
      "mutation_tool_without_workstream_binding",
      "long_running_tool_without_workstream_binding",
      "tool_not_allowed_in_phase",
    ]));
    expect(audit.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "mutation_tool_without_workstream_binding",
        severity: "error",
        tools: ["write_files", "process_start"],
      }),
      expect.objectContaining({
        code: "long_running_tool_without_workstream_binding",
        tools: ["process_start"],
      }),
    ]));
  });

  it("allows routing controls only before binding", () => {
    const routing = auditToolPolicy({
      policy: policy({ routingAvailable: true }),
      selectedTools: ["git_context_create_workstream"],
    });
    const bound = auditToolPolicy({
      policy: policy({ workstreamBound: true, routingAvailable: false }),
      selectedTools: ["git_context_create_workstream"],
    });

    expect(routing.phase).toBe("routing");
    expect(routing.violations).toEqual([]);
    expect(bound.phase).toBe("workstream_bound");
    expect(bound.warningCodes).toEqual(expect.arrayContaining([
      "routing_control_after_workstream_bound",
      "tool_not_allowed_in_phase",
    ]));
  });

  it("flags selected tools missing taxonomy", () => {
    const audit = auditToolPolicy({
      policy: policy({ workstreamBound: true }),
      selectedTools: ["unknown_tool"],
    });

    expect(audit.taxonomy.unknown).toEqual(["unknown_tool"]);
    expect(audit.violations).toEqual([
      expect.objectContaining({ code: "unknown_tool_taxonomy", severity: "error" }),
    ]);
  });
});

function policy(
  overrides: Partial<WorkstreamBindingCapabilityPolicy> = {},
): WorkstreamBindingCapabilityPolicy {
  return {
    workstreamBound: false,
    routingSuppressed: false,
    routingAvailable: false,
    routingFailureLimitReached: false,
    allowToolLoading: true,
    ...overrides,
  };
}
