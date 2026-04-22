import { describe, expect, it } from "vitest";
import { builtInSkillsProvider } from "../../src/skills/provider.js";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDatasetSkill } from "../../src/skills/builtins/datasets/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createIdentitySkill } from "../../src/skills/builtins/identity/index.js";
import { createPythonSkill } from "../../src/skills/builtins/python/index.js";
import { createRecallSkill } from "../../src/skills/builtins/recall/index.js";
import { createWikiSkill } from "../../src/skills/builtins/wiki/index.js";
import type { PreparedAttachmentService } from "../../src/documents/prepared-attachment-service.js";
import type { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";
import type { MemoryRetriever } from "../../src/memory/retrieval/memory-retriever.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import type { UserWikiStore } from "../../src/context/wiki-store.js";

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

async function buildRuntimeTools(): Promise<ToolDefinition[]> {
  const builtInTools = await builtInSkillsProvider.getAllTools();
  const preparedAttachmentService = {} as unknown as PreparedAttachmentService;

  return [
    ...builtInTools,
    ...createIdentitySkill({ onSoulUpdated: () => undefined }).tools,
    ...createRecallSkill({
      retriever: { recall: async () => [] } as unknown as MemoryRetriever,
    }).tools,
    ...createWikiSkill({
      wikiStore: {} as unknown as UserWikiStore,
      onProfileUpdated: () => undefined,
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
    expect(tools.some((tool) => tool.name === "python_execute")).toBe(true);
    expect(issues).toEqual([]);
  });
});
