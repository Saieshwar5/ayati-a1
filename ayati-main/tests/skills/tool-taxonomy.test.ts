import { describe, expect, it } from "vitest";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../../src/skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createFilesSkill } from "../../src/skills/builtins/files/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createMemorySkill } from "../../src/skills/builtins/memory/index.js";
import { createPythonSkill } from "../../src/skills/builtins/python/index.js";
import { createRecallSkill } from "../../src/skills/builtins/recall/index.js";
import { createUiSkill } from "../../src/skills/builtins/ui/index.js";
import { createContextSkill } from "../../src/skills/builtins/context/index.js";
import { createSystemSkill } from "../../src/skills/builtins/system/index.js";
import { builtInSkillsProvider } from "../../src/skills/provider.js";
import type { SkillDefinition } from "../../src/skills/types.js";
import { CapabilityCatalog } from "../../src/ivec/agent-runner/capabilities/catalog.js";
import { ToolRegistry } from "../../src/ivec/agent-runner/capabilities/registry.js";
import { createEmptyHotContextRuntime } from "../../src/ivec/hot-context/index.js";
import {
  canRunBeforeWorkstream,
  getToolTaxonomy,
  getToolPurpose,
  hasMutationEffect,
  isObservationalTool,
  isNativeControlToolName,
  isRoutingTool,
  isToolAllowedInPhase,
  missingToolTaxonomy,
  requiresWorkstreamBinding,
  summarizeToolTaxonomy,
} from "../../src/skills/tool-taxonomy.js";

describe("tool taxonomy", () => {
  it("covers every static and runtime built-in tool", async () => {
    const skills = [
      ...await builtInSkillsProvider.getAllSkills(),
      ...runtimeSkills(),
    ];
    const tools = skills.flatMap((skill) => skill.tools);

    expect(missingToolTaxonomy(tools)).toEqual([]);
    expect(() => ToolRegistry.fromSkills(skills).assertCapabilityCoverage(
      new CapabilityCatalog(),
    )).not.toThrow();
  });

  it("classifies list, read, search, control, mutation, and long-running tools", () => {
    expect(getToolTaxonomy("read_file")).toBeUndefined();
    expect(isObservationalTool("read_files")).toBe(true);
    expect(getToolPurpose("read_files")).toBe("read");
    expect(getToolPurpose("system_time")).toBe("read");
    expect(getToolPurpose("system_health")).toBe("read");
    expect(canRunBeforeWorkstream("system_time")).toBe(true);
    expect(requiresWorkstreamBinding("system_health")).toBe(false);
    expect(getToolPurpose("search_in_files")).toBe("search");
    expect(getToolPurpose("list_directory")).toBe("list");
    expect(isObservationalTool("list_directory")).toBe(true);
    expect(canRunBeforeWorkstream("read_files")).toBe(true);
    expect(requiresWorkstreamBinding("read_files")).toBe(false);
    expect(getToolTaxonomy("read_files")).toMatchObject({ lifetime: "run" });
    expect(getToolTaxonomy("write_files")).toMatchObject({ lifetime: "run" });
    expect(isRoutingTool("git_context_create_workstream")).toBe(true);
    expect(getToolPurpose("git_context_create_workstream")).toBe("control");
    expect(hasMutationEffect("git_context_create_workstream")).toBe(true);
    expect(canRunBeforeWorkstream("git_context_create_workstream")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_workstream", "routing")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_workstream", "workstream_bound")).toBe(false);
    expect(getToolPurpose("git_context_find_workstreams")).toBe("search");
    expect(getToolPurpose("git_context_read_workstream")).toBe("read");
    expect(getToolPurpose("git_context_set_workstream_star")).toBe("control");
    expect(canRunBeforeWorkstream("git_context_set_workstream_star")).toBe(true);

    expect(getToolTaxonomy("write_file")).toBeUndefined();
    expect(hasMutationEffect("write_files")).toBe(true);
    expect(getToolPurpose("write_files")).toBe("mutation");
    expect(requiresWorkstreamBinding("write_files")).toBe(true);
    expect(canRunBeforeWorkstream("write_files")).toBe(false);
    expect(isToolAllowedInPhase("write_files", "workstream_bound")).toBe(true);
    expect(isToolAllowedInPhase("write_files", "enquiry")).toBe(false);

    expect(getToolTaxonomy("process_start")).toMatchObject({
      lifetime: "background",
      roles: expect.arrayContaining(["long_running_process"]),
    });
    expect(getToolPurpose("process_poll")).toBe("control");
    expect(isObservationalTool("process_poll")).toBe(false);
    expect(getToolPurpose("process_stop")).toBe("control");
    expect(getToolPurpose("attachment_restore")).toBe("control");
    expect(isNativeControlToolName("decision_enter_observe_investigate")).toBe(true);
    expect(isNativeControlToolName("decision_enter_workstream_route")).toBe(true);
    expect(isNativeControlToolName("decision_resolve_create")).toBe(true);
    expect(isNativeControlToolName("decision_transition_mode")).toBe(false);
    expect(isNativeControlToolName("decision_stop")).toBe(true);
    expect(isNativeControlToolName("decision_load_tools")).toBe(false);
    expect(getToolPurpose("decision_stop")).toBe("control");
  });

  it("summarizes selected tool classes for feedback", () => {
    const summary = summarizeToolTaxonomy([
      "read_files",
      "write_files",
      "git_context_activate_workstream",
      "process_start",
      "unknown_tool",
    ]);

    expect(summary.known).toEqual([
      "read_files",
      "write_files",
      "git_context_activate_workstream",
      "process_start",
    ]);
    expect(summary.unknown).toEqual(["unknown_tool"]);
    expect(summary.effects).toMatchObject({
      read_only: 1,
      workspace_mutation: 2,
      context_mutation: 1,
    });
    expect(summary.purposes).toMatchObject({
      list: 0,
      read: 1,
      search: 0,
      control: 1,
      mutation: 2,
    });
    expect(summary.roles).toMatchObject({
      workstream_routing: 1,
      workstream_mutation: 1,
      long_running_process: 1,
    });
    expect(summary.requiresWorkstreamBinding).toEqual(["write_files", "process_start"]);
    expect(summary.canRunBeforeWorkstream).toEqual(["read_files", "git_context_activate_workstream"]);
    expect(summary.longRunning).toEqual(["process_start"]);
    expect(summary.lifetimes).toMatchObject({
      run: 2,
      single_use: 1,
      background: 1,
    });
  });
});

function runtimeSkills(): SkillDefinition[] {
  const stub = {} as any;
  return [
    createContextSkill({ hotContextRuntime: createEmptyHotContextRuntime() }),
    createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/tmp",
    }),
    createRecallSkill({ retriever: stub, controls: stub }),
    createMemorySkill({ store: stub, defaultUserId: "taxonomy-test" }),
    createPythonSkill({ dataDir: "/tmp/ayati-tool-taxonomy" }),
    createAttachmentSkill({ sessionAttachmentService: stub }),
    createDatasetSkill({ preparedAttachmentService: stub }),
    createDocumentSkill({ preparedAttachmentService: stub }),
    createFilesSkill({ fileLibrary: stub, directoryLibrary: stub }),
    createGitContextSkill({ service: stub }),
    createUiSkill({ workspaceOrchestrator: stub }),
  ];
}
