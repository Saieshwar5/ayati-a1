import { describe, expect, it } from "vitest";
import { builtInSkillsProvider } from "../../src/skills/provider.js";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../../src/skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createPythonSkill } from "../../src/skills/builtins/python/index.js";
import { createRecallSkill } from "../../src/skills/builtins/recall/index.js";
import { createUiSkill } from "../../src/skills/builtins/ui/index.js";
import type { PreparedAttachmentService } from "../../src/documents/prepared-attachment-service.js";
import type { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";
import type { RecallRetriever } from "../../src/skills/builtins/recall/index.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { WorkspaceOrchestrator } from "../../src/ui/workspace-orchestrator.js";
import { ContractOnlyGitContextService } from "ayati-git-context";

function findMissingArrayItems(schema: unknown, path = "inputSchema"): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) => findMissingArrayItems(entry, `${path}[${index}]`));
  }

  const record = schema as Record<string, unknown>;
  const issues = record["type"] === "array" && record["items"] === undefined
    ? [`${path} is missing items`]
    : [];

  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      issues.push(...value.flatMap((entry, index) => findMissingArrayItems(entry, `${path}.${key}[${index}]`)));
      continue;
    }
    if (value && typeof value === "object") {
      if (key === "properties") {
        for (const [propertyName, propertySchema] of Object.entries(value as Record<string, unknown>)) {
          issues.push(...findMissingArrayItems(propertySchema, `${path}.properties.${propertyName}`));
        }
        continue;
      }
      issues.push(...findMissingArrayItems(value, `${path}.${key}`));
    }
  }

  return issues;
}

function findFilesystemPathDescriptionIssues(schema: unknown, path = "inputSchema"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const record = schema as Record<string, unknown>;
  const issues: string[] = [];
  const properties = record["properties"];
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
      if (!propertySchema || typeof propertySchema !== "object" || Array.isArray(propertySchema)) continue;
      const property = propertySchema as Record<string, unknown>;
      if (["path", "paths", "roots", "source", "destination"].includes(name)) {
        const description = typeof property["description"] === "string" ? property["description"].toLowerCase() : "";
        if (!description.includes("absolute")) {
          issues.push(`${path}.properties.${name} must describe an absolute path`);
        }
      }
      issues.push(...findFilesystemPathDescriptionIssues(propertySchema, `${path}.properties.${name}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") continue;
    if (Array.isArray(value)) {
      issues.push(...value.flatMap((entry, index) =>
        findFilesystemPathDescriptionIssues(entry, `${path}.${key}[${index}]`)));
    } else if (value && typeof value === "object") {
      issues.push(...findFilesystemPathDescriptionIssues(value, `${path}.${key}`));
    }
  }
  return issues;
}

async function buildRuntimeTools(): Promise<ToolDefinition[]> {
  const builtInTools = await builtInSkillsProvider.getAllTools();
  const preparedAttachmentService = {} as unknown as PreparedAttachmentService;

  return [
    ...builtInTools,
    ...createRecallSkill({
      retriever: { recall: async () => [] } satisfies RecallRetriever,
    }).tools,
    ...createPythonSkill({
      dataDir: "/tmp/ayati-test-data",
      interpreterPath: "/tmp/fake-python",
    }).tools,
    ...createAttachmentSkill({
      sessionAttachmentService: {} as unknown as SessionAttachmentService,
    }).tools,
    ...createDatasetSkill({
      preparedAttachmentService,
    }).tools,
    ...createDocumentSkill({
      preparedAttachmentService,
    }).tools,
    ...createGitContextSkill({
      service: new ContractOnlyGitContextService(),
    }).tools,
    ...createUiSkill({
      workspaceOrchestrator: new WorkspaceOrchestrator({
        dataDir: "/tmp/ayati-test-data",
        hyprlandEnabled: false,
      }),
    }).tools,
  ];
}

describe("runtime tool schemas", () => {
  it("defines items for every array input schema in the runtime tool set", async () => {
    const tools = await buildRuntimeTools();

    const issues = tools.flatMap((tool) => {
      const schemaIssues = findMissingArrayItems(tool.inputSchema);
      return schemaIssues.map((issue) => `${tool.name}: ${issue}`);
    });

    expect(tools.some((tool) => tool.name === "db_create_table")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_context_activate_task")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_context_create_task")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_context_switch_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "python_execute")).toBe(true);
    expect(tools.some((tool) => tool.name.startsWith("learning_"))).toBe(false);
    expect(tools.some((tool) => tool.name.startsWith("ui_open_learning_"))).toBe(false);
    const createTask = tools.find((tool) => tool.name === "git_context_create_task");
    expect(createTask?.inputSchema.properties).not.toHaveProperty("placement");
    expect(createTask?.inputSchema.required).toEqual(["title", "objective", "reason"]);
    expect(createTask?.inputSchema.properties).not.toHaveProperty("directory");
    const activateTask = tools.find((tool) => tool.name === "git_context_activate_task");
    expect(activateTask?.inputSchema.properties?.["requestDecision"]).toMatchObject({ type: "object" });
    expect(activateTask?.inputSchema.required).toEqual(["taskId", "reason", "requestDecision"]);
    expect(createTask?.outputSchema.properties?.["workingDirectory"]).toMatchObject({ type: "string" });
    expect(issues).toEqual([]);
  });

  it("advertises absolute paths for every filesystem resource field", async () => {
    const tools = await buildRuntimeTools();
    const filesystemTools = new Set([
      "inspect_paths",
      "read_files",
      "write_files",
      "patch_files",
      "delete",
      "list_directory",
      "create_directory",
      "move",
      "find_files",
      "search_in_files",
    ]);
    const issues = tools
      .filter((tool) => filesystemTools.has(tool.name))
      .flatMap((tool) => findFilesystemPathDescriptionIssues(tool.inputSchema)
        .map((issue) => `${tool.name}: ${issue}`));

    expect(issues).toEqual([]);
  });
});
