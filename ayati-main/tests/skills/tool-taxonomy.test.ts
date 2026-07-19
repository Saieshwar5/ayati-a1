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
import { builtInSkillsProvider } from "../../src/skills/provider.js";
import type { SkillDefinition } from "../../src/skills/types.js";
import {
  canRunBeforeTask,
  getToolTaxonomy,
  getToolPurpose,
  hasMutationEffect,
  isObservationalTool,
  isNativeControlToolName,
  isRoutingTool,
  isToolAllowedInPhase,
  getToolLoadGroups,
  missingToolTaxonomy,
  requiresTaskBinding,
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
  });

  it("classifies list, read, search, control, mutation, and long-running tools", () => {
    expect(getToolTaxonomy("read_file")).toBeUndefined();
    expect(isObservationalTool("read_files")).toBe(true);
    expect(getToolPurpose("read_files")).toBe("read");
    expect(getToolPurpose("search_in_files")).toBe("search");
    expect(getToolPurpose("list_directory")).toBe("list");
    expect(isObservationalTool("list_directory")).toBe(true);
    expect(canRunBeforeTask("read_files")).toBe(true);
    expect(requiresTaskBinding("read_files")).toBe(false);
    expect(getToolTaxonomy("read_files")).toMatchObject({ lifetime: "run" });
    expect(getToolTaxonomy("write_files")).toMatchObject({ lifetime: "run" });
    expect(getToolLoadGroups("write_files")).toEqual(expect.arrayContaining(["file:write", "file:create"]));

    expect(isRoutingTool("git_context_create_task")).toBe(true);
    expect(getToolPurpose("git_context_create_task")).toBe("control");
    expect(hasMutationEffect("git_context_create_task")).toBe(true);
    expect(canRunBeforeTask("git_context_create_task")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_task", "routing")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_task", "task_bound")).toBe(false);
    expect(getToolPurpose("git_context_find_tasks")).toBe("search");
    expect(getToolPurpose("git_context_read_task")).toBe("read");
    expect(getToolPurpose("git_context_set_task_star")).toBe("control");
    expect(canRunBeforeTask("git_context_set_task_star")).toBe(true);

    expect(getToolTaxonomy("write_file")).toBeUndefined();
    expect(hasMutationEffect("write_files")).toBe(true);
    expect(getToolPurpose("write_files")).toBe("mutation");
    expect(requiresTaskBinding("write_files")).toBe(true);
    expect(canRunBeforeTask("write_files")).toBe(false);
    expect(isToolAllowedInPhase("write_files", "task_bound")).toBe(true);
    expect(isToolAllowedInPhase("write_files", "enquiry")).toBe(false);

    expect(getToolTaxonomy("process_start")).toMatchObject({
      lifetime: "background",
      roles: expect.arrayContaining(["long_running_process"]),
    });
    expect(getToolPurpose("process_poll")).toBe("control");
    expect(isObservationalTool("process_poll")).toBe(false);
    expect(getToolPurpose("process_stop")).toBe("control");
    expect(getToolPurpose("attachment_restore")).toBe("control");
    expect(isNativeControlToolName("decision_load_tools")).toBe(true);
    expect(getToolPurpose("task_completion")).toBe("control");
  });

  it("summarizes selected tool classes for feedback", () => {
    const summary = summarizeToolTaxonomy([
      "read_files",
      "write_files",
      "git_context_activate_task",
      "process_start",
      "unknown_tool",
    ]);

    expect(summary.known).toEqual([
      "read_files",
      "write_files",
      "git_context_activate_task",
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
      task_routing: 1,
      task_mutation: 1,
      long_running_process: 1,
    });
    expect(summary.requiresTaskBinding).toEqual(["write_files", "process_start"]);
    expect(summary.canRunBeforeTask).toEqual(["read_files", "git_context_activate_task"]);
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
