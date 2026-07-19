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
    const processTool = tool("process_run");
    const documentQuery = tool("document_query", "Query documents");
    const catalog = new SkillCatalog([
      createSkillBundle(skill("documents", [documentQuery])),
    ]);
    const executor = createToolExecutor([processTool]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    expect(executor.list({ runId: "r1", sessionId: "s1" })).toEqual(["process_run"]);

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
    expect(executor.list({ runId: "r1", sessionId: "s1", stepNumber: 3 })).toEqual(["process_run"]);
  });

  it("auto-activates attachment handling skills for runs with attachments", async () => {
    const catalog = new SkillCatalog([
      createSkillBundle(skill("attachments", [tool("attachment_restore")])),
      createSkillBundle(skill("files", [tool("attachment_list")])),
      createSkillBundle(skill("documents", [tool("document_query")])),
      createSkillBundle(skill("datasets", [tool("dataset_query")])),
    ]);
    const executor = createToolExecutor([tool("process_run")]);
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
      "attachment_restore",
      "attachment_list",
      "document_query",
      "dataset_query",
    ]));
  });

  it("auto-activates attachment handling skills for workstream resources", async () => {
    const catalog = new SkillCatalog([
      createSkillBundle(skill("attachments", [tool("attachment_restore")])),
      createSkillBundle(skill("files", [tool("attachment_query")])),
      createSkillBundle(skill("documents", [tool("document_query")])),
      createSkillBundle(skill("datasets", [tool("dataset_query")])),
    ]);
    const executor = createToolExecutor([tool("process_run")]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    const activated = await manager.prepareForDecision({
      harnessContext: {
        contextEngine: {
          session: {
            meta: { sessionId: "2026-06-17", resourceCount: 1 },
            conversationTail: [],
            activityTail: [],
          },
          focus: {
            status: "active",
            ref: "refs/heads/main",
            workstreamId: "W-20260617-0001",
          },
          workstream: {
            contextRepositoryPath: "/ayati/workstreams/W-20260617-0001-policy-review",
            ref: "refs/heads/main",
            workstreamId: "W-20260617-0001",
            title: "Policy review",
            objective: "Review policy document",
            summary: "Review policy.txt",
            workstreamStatus: "in_progress",
            lifecycleStatus: "active",
            repositoryHealth: "ready",
            blockers: [],
            resources: [{
              resource: {
                resourceId: `RES-${"A".repeat(24)}`,
                kind: "document",
                origin: "user_attachment",
                displayName: "policy.txt",
                description: "Policy document under review",
                aliases: ["policy"],
                locator: { kind: "managed_blob", resourceId: `RES-${"A".repeat(24)}` },
                version: {
                  key: "sha256:policy",
                  observedAt: "2026-06-17T10:00:00.000Z",
                  exists: true,
                  kind: "file",
                  sha256: "policy",
                },
                availability: "available",
                metadataStatus: "enriched",
                createdAt: "2026-06-17T10:00:00.000Z",
                updatedAt: "2026-06-17T10:00:00.000Z",
              },
              role: "input",
              access: "read",
              primary: false,
              requestIds: ["R-0001"],
              boundAt: "2026-06-17T10:00:00.000Z",
            }],
            recentCommits: [],
          },
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
    const executor = createToolExecutor([tool("process_run")]);
    const manager = new SkillActivationManager({ catalog, toolExecutor: executor });

    const results = await manager.search({ query: "summarize pdf sections" });

    expect(results).toHaveLength(1);
    expect((results[0] as { skillId?: string }).skillId).toBe("documents");
    expect(executor.list({ runId: "r1", sessionId: "s1" })).toEqual(["process_run"]);
  });
});
