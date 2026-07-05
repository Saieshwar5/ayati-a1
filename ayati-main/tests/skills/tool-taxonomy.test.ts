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
  isMutationTool,
  isReadOnlyTool,
  isRoutingTool,
  isToolAllowedInPhase,
  missingToolTaxonomy,
  requiresTaskRun,
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

  it("classifies read-only, routing, mutation, and long-running tools", () => {
    expect(isReadOnlyTool("read_file")).toBe(true);
    expect(canRunBeforeTask("read_file")).toBe(true);
    expect(requiresTaskRun("read_file")).toBe(false);

    expect(isRoutingTool("git_context_create_task_for_turn")).toBe(true);
    expect(isMutationTool("git_context_create_task_for_turn")).toBe(true);
    expect(canRunBeforeTask("git_context_create_task_for_turn")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_task_for_turn", "routing")).toBe(true);
    expect(isToolAllowedInPhase("git_context_create_task_for_turn", "task_run")).toBe(false);

    expect(isMutationTool("write_file")).toBe(true);
    expect(requiresTaskRun("write_file")).toBe(true);
    expect(canRunBeforeTask("write_file")).toBe(false);
    expect(isToolAllowedInPhase("write_file", "task_run")).toBe(true);
    expect(isToolAllowedInPhase("write_file", "enquiry")).toBe(false);

    expect(getToolTaxonomy("shell_session_start")).toMatchObject({
      lifetime: "background",
      roles: expect.arrayContaining(["long_running_process"]),
    });
  });

  it("summarizes selected tool classes for feedback", () => {
    const summary = summarizeToolTaxonomy([
      "read_file",
      "write_file",
      "git_context_activate_task_for_turn",
      "shell_session_start",
      "unknown_tool",
    ]);

    expect(summary.known).toEqual([
      "read_file",
      "write_file",
      "git_context_activate_task_for_turn",
      "shell_session_start",
    ]);
    expect(summary.unknown).toEqual(["unknown_tool"]);
    expect(summary.effects).toMatchObject({
      read_only: 1,
      workspace_mutation: 2,
      context_mutation: 1,
    });
    expect(summary.roles).toMatchObject({
      task_routing: 1,
      task_mutation: 1,
      long_running_process: 1,
    });
    expect(summary.requiresTaskRun).toEqual(["write_file", "shell_session_start"]);
    expect(summary.canRunBeforeTask).toEqual(["read_file", "git_context_activate_task_for_turn"]);
    expect(summary.longRunning).toEqual(["shell_session_start"]);
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
    createGitContextSkill({ contextStoreDir: "/tmp/ayati-tool-taxonomy", gitMemoryRuntime: stub }),
    createUiSkill({ workspaceOrchestrator: stub }),
  ];
}
