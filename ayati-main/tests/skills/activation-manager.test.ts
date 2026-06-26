import { describe, expect, it } from "vitest";
import { SkillActivationManager } from "../../src/skills/activation-manager.js";
import { SkillCatalog, createSkillBundle } from "../../src/skills/skill-catalog.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";

function tool(name: string, description = name): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
    },
    async execute() {
      return { ok: true, output: `${name}-ok` };
    },
  };
}

function skill(id: string, tools: ToolDefinition[]): SkillDefinition {
  return {
    id,
    version: "1.0.0",
    description: `${id} skill`,
    promptBlock: `${id} prompt`,
    tools,
  };
}

describe("SkillActivationManager", () => {
  it("activates built-in skill tools into the executor for the current run", async () => {
    const shell = tool("shell");
    const documentQuery = tool("document_query", "Query documents");
    const catalog = new SkillCatalog([
      createSkillBundle(skill("documents", [documentQuery])),
    ]);
    const executor = createToolExecutor([shell]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    expect(executor.list({ runId: "r1", sessionId: "s1" })).toEqual(["shell"]);

    const activation = await manager.activate({ skillId: "documents", scope: "run" }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });

    expect(activation.ok).toBe(true);
    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 2 })).toContain("document_query");
    expect(executor.list({ runId: "r2", sessionId: "s1", stepNumber: 2 })).not.toContain("document_query");

    manager.deactivateRun({ clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 2 });
    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 3 })).toEqual(["shell"]);
  });

  it("auto-activates attachment handling skills for runs with attachments", async () => {
    const catalog = new SkillCatalog([
      createSkillBundle(skill("attachments", [tool("restore_attachment_context")])),
      createSkillBundle(skill("files", [tool("attachment_list")])),
      createSkillBundle(skill("documents", [tool("document_query")])),
      createSkillBundle(skill("datasets", [tool("dataset_query")])),
    ]);
    const executor = createToolExecutor([tool("shell")]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    const activated = await manager.prepareForDecision({
      attachedDocuments: [{ documentId: "doc1" }],
    }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });

    expect(activated.map((record) => record.skillId).sort()).toEqual(["attachments", "datasets", "documents", "files"]);
    const visible = executor.list({ clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });
    expect(visible).toEqual(expect.arrayContaining([
      "restore_attachment_context",
      "attachment_list",
      "document_query",
      "dataset_query",
    ]));
  });

  it("auto-activates attachment handling skills for activity continuation assets", async () => {
    const catalog = new SkillCatalog([
      createSkillBundle(skill("attachments", [tool("attachment_restore")])),
      createSkillBundle(skill("files", [tool("attachment_query")])),
      createSkillBundle(skill("documents", [tool("document_query")])),
      createSkillBundle(skill("datasets", [tool("dataset_query")])),
    ]);
    const executor = createToolExecutor([tool("shell")]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    const activated = await manager.prepareForDecision({
      continuity: {
        mode: "continue",
        confidence: 0.92,
        reasons: ["matched durable activity identity anchor"],
        current: {
          activityId: "activity_policy",
          kind: "document",
          title: "policy review",
          openWork: [],
          verifiedFacts: [],
          topAssets: ["policy.txt"],
          lastTouchedAt: "2026-06-17T00:00:00.000Z",
        },
      },
    }, {
      clientId: "c1",
      runId: "r1",
      sessionId: "s1",
      stepNumber: 1,
    });

    expect(activated.map((record) => record.skillId).sort()).toEqual(["attachments", "datasets", "documents", "files"]);
    const visible = executor.list({ clientId: "c1", runId: "r1", sessionId: "s1", stepNumber: 1 });
    expect(visible).toEqual(expect.arrayContaining([
      "attachment_restore",
      "attachment_query",
      "document_query",
      "dataset_query",
    ]));
  });

  it("searches compact skill cards without activating full schemas", async () => {
    const catalog = new SkillCatalog([
      createSkillBundle(skill("documents", [tool("document_query")])),
    ]);
    const executor = createToolExecutor([tool("shell")]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    const results = await manager.search({ query: "summarize pdf sections" });

    expect(results).toHaveLength(1);
    expect((results[0] as { skillId?: string }).skillId).toBe("documents");
    expect(executor.list({ runId: "r1", sessionId: "s1" })).toEqual(["shell"]);
  });
});
