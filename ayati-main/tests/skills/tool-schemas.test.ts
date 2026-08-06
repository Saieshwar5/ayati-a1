import { describe, expect, it } from "vitest";
import { builtInSkillsProvider } from "../../src/skills/provider.js";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createGitContextSkill } from "../../src/skills/builtins/git-context/index.js";
import { createGitReadSkill } from "../../src/skills/builtins/git-read/index.js";
import { createPythonSkill } from "../../src/skills/builtins/python/index.js";
import { createSystemSkill } from "../../src/skills/builtins/system/index.js";
import type { SessionAttachmentService } from "../../src/files/session-attachment-service.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { ContextEngineService } from "ayati-context-engine";

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
  const contextEngineService = {} as ContextEngineService;
  const builtInTools = (await builtInSkillsProvider.getAllSkills())
    .flatMap((skill) => skill.tools);
  return [
    ...builtInTools,
    ...createSystemSkill({
      defaultTimezone: "UTC",
      healthRoot: "/tmp",
    }).tools,
    ...createPythonSkill({
      dataDir: "/tmp/ayati-test-data",
      interpreterPath: "/tmp/fake-python",
    }).tools,
    ...createAttachmentSkill({
      sessionAttachmentService: {} as unknown as SessionAttachmentService,
    }).tools,
    ...createGitContextSkill({
      service: contextEngineService,
    }).tools,
    ...createGitReadSkill({
      service: contextEngineService,
      workstreamRoot: "/tmp/ayati-workstreams",
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
    expect(tools.some((tool) => tool.name === "git_context_activate_workstream")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_context_create_workstream")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_read")).toBe(true);
    expect(tools.some((tool) => tool.name === "git_context_log")).toBe(false);
    expect(tools.some((tool) => tool.name === "git_context_show")).toBe(false);
    expect(tools.some((tool) => tool.name === "git_context_diff")).toBe(false);
    expect(tools.some((tool) => tool.name === "git_context_switch_task")).toBe(false);
    expect(tools.some((tool) => tool.name === "python_execute")).toBe(true);
    const createWorkstream = tools.find((tool) => tool.name === "git_context_create_workstream");
    expect(createWorkstream?.inputSchema.properties).not.toHaveProperty("placement");
    expect(createWorkstream?.inputSchema.required).toEqual(["title", "objective", "reason"]);
    expect(createWorkstream?.inputSchema.properties).not.toHaveProperty("directory");
    expect(createWorkstream?.inputSchema.properties?.["resources"]).toMatchObject({ type: "array" });
    const activateWorkstream = tools.find((tool) => tool.name === "git_context_activate_workstream");
    expect(activateWorkstream?.description)
      .toContain("Any added or removed independently acceptable scope");
    expect(activateWorkstream?.inputSchema.properties?.["requestDecision"]).toMatchObject({
      type: "object",
      description: expect.stringContaining("unchanged active contract"),
      properties: {
        kind: {
          enum: [
            "continue_current",
            "activate_existing",
            "resume_blocked",
            "amend_current",
            "create_and_activate",
            "create_queued",
            "defer_current_and_activate_existing",
            "defer_current_and_create",
          ],
          description: expect.stringContaining("continue_current"),
        },
        requestId: {
          description: expect.stringContaining("Exact request"),
        },
        currentRequestId: {
          pattern: "^R-[0-9]{4}$",
          description: expect.stringContaining("active request"),
        },
        request: {
          description: expect.stringContaining("new immutable request identity"),
        },
      },
    });
    expect(activateWorkstream?.inputSchema.required).toEqual(["workstreamId", "reason", "requestDecision"]);
    expect(createWorkstream?.outputSchema.properties).not.toHaveProperty("contextRepositoryPath");
    expect(createWorkstream?.outputSchema.properties?.["streamId"]).toMatchObject({ type: "string" });
    expect(createWorkstream?.outputSchema.properties?.["resources"]).toMatchObject({ type: "array" });
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
