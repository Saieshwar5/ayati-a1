import { describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_BOUND_RESOURCE_TOOL_NAMES,
  GIT_CONTEXT_READ_ONLY_TOOL_NAMES,
  GIT_CONTEXT_PREFERENCE_TOOL_NAMES,
  GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES,
  GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES,
  isGitContextAllowedDuringPendingRouting,
  isGitContextBoundResourceToolName,
  isGitContextReadOnlyToolName,
  isGitContextPreferenceToolName,
  isGitContextRoutingSupportToolName,
  isGitContextTurnRoutingToolName,
} from "../../src/skills/builtins/git-context/tool-policy.js";

describe("git-context tool policy", () => {
  it("allows read-only and turn-aware routing tools during pending-turn routing", () => {
    for (const toolName of GIT_CONTEXT_READ_ONLY_TOOL_NAMES) {
      expect(isGitContextReadOnlyToolName(toolName)).toBe(true);
      expect(isGitContextAllowedDuringPendingRouting(toolName)).toBe(true);
    }

    for (const toolName of GIT_CONTEXT_TURN_ROUTING_TOOL_NAMES) {
      expect(isGitContextTurnRoutingToolName(toolName)).toBe(true);
      expect(isGitContextAllowedDuringPendingRouting(toolName)).toBe(true);
    }

    for (const toolName of GIT_CONTEXT_PREFERENCE_TOOL_NAMES) {
      expect(isGitContextPreferenceToolName(toolName)).toBe(true);
      expect(isGitContextAllowedDuringPendingRouting(toolName)).toBe(true);
    }

    for (const toolName of GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES) {
      expect(isGitContextRoutingSupportToolName(toolName)).toBe(true);
      expect(isGitContextAllowedDuringPendingRouting(toolName)).toBe(true);
    }

    expect(GIT_CONTEXT_ROUTING_SUPPORT_TOOL_NAMES).toEqual([
      "git_context_inspect_resource",
    ]);
    expect(isGitContextRoutingSupportToolName("git_context_bind_resources")).toBe(false);
    expect(isGitContextAllowedDuringPendingRouting("git_context_bind_resources")).toBe(false);
    expect(GIT_CONTEXT_BOUND_RESOURCE_TOOL_NAMES).toEqual([
      "git_context_bind_resources",
    ]);
    expect(isGitContextBoundResourceToolName("git_context_bind_resources")).toBe(true);
  });

  it("blocks low-level branch and normal work tools during pending-turn routing", () => {
    expect(isGitContextAllowedDuringPendingRouting("git_context_create_branch")).toBe(false);
    expect(isGitContextAllowedDuringPendingRouting("git_context_switch_branch")).toBe(false);
    expect(isGitContextAllowedDuringPendingRouting("process_run")).toBe(false);
    expect(isGitContextAllowedDuringPendingRouting("patch_files")).toBe(false);
  });
});
