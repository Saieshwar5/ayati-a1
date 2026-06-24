import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { DocumentStore } from "../../src/documents/document-store.js";
import { PreparedAttachmentRegistry } from "../../src/documents/prepared-attachment-registry.js";
import { PreparedAttachmentService } from "../../src/documents/prepared-attachment-service.js";
import { SessionAttachmentService } from "../../src/documents/session-attachment-service.js";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import { MemoryManager } from "../../src/memory/session-manager.js";
import { createActivitySkill } from "../../src/skills/builtins/activity/index.js";
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ayati-activity-continuation-"));
  tempDirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map((response) => JSON.stringify(response));
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true } },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn().mockImplementation(async () => {
      const content = queue.shift();
      if (!content) {
        throw new Error("No queued provider response");
      }
      return { type: "assistant", content };
    }),
  };
}

describe("activity continuation in the agent loop", () => {
  it("restores a user-attached document from the resolved activity in a later run", async () => {
    const dataDir = makeTmpDir();
    let now = new Date("2026-06-12T09:00:00.000Z");
    const memory = new MemoryManager({
      dataDir: join(dataDir, "memory"),
      now: () => now,
    });
    memory.initialize("c1");

    try {
      const policyPath = join(dataDir, "policy.txt");
      writeFileSync(
        policyPath,
        [
          "Termination requires 30 days notice.",
          "Renewal happens automatically unless cancelled in writing.",
        ].join("\n"),
        "utf-8",
      );

      const documentStore = new DocumentStore({
        dataDir: join(dataDir, "documents"),
        preferCli: false,
      });
      const registry = new PreparedAttachmentRegistry();
      const preparedAttachmentService = new PreparedAttachmentService({
        registry,
        documentStore,
        provider: createProvider([]),
      });
      const sessionAttachmentService = new SessionAttachmentService({
        activityStore: memory.getActivityStore(),
        preparedAttachmentRegistry: registry,
        dataDir,
      });
      const tools = [
        ...createActivitySkill({ store: memory.getActivityStore(), defaultClientId: "c1" }).tools,
        ...createAttachmentSkill({ sessionAttachmentService }).tools,
        ...createDocumentSkill({ preparedAttachmentService }).tools,
      ];
      const toolExecutor = createToolExecutor(tools);
      const registered = await documentStore.registerAttachments([{ path: policyPath, name: "policy.txt" }]);

      const input1 = memory.recordUserMessage("c1", "What does the policy say about termination?");
      const run1 = memory.createWorkRun("c1", input1);
      const firstResult = await agentLoop({
        provider: createProvider([
          {
            kind: "act",
            action: {
              mode: "single",
              calls: [{
                id: "query_policy",
                tool: "document_query",
                input: { query: "termination" },
                dependsOn: [],
                purpose: "Query the attached policy document",
              }],
              allowedTools: ["document_query"],
              assertions: [],
            },
          },
          {
            kind: "reply",
            status: "completed",
            message: "Termination requires 30 days notice.",
          },
        ]),
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: memory,
        inputHandle: input1,
        runHandle: run1,
        clientId: "c1",
        initialUserMessage: "What does the policy say about termination?",
        dataDir,
        systemContext: "test",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry: registry,
      });

      expect(firstResult.taskSummary?.activityAssets?.[0]).toMatchObject({
        kind: "document",
        origin: "user_attached",
        role: "input",
        displayName: "policy.txt",
      });
      memory.queueTaskSummary("c1", {
        ...firstResult.taskSummary!,
        sessionId: run1.sessionId,
      });

      const activity = memory.getActivityStore().search("c1", "policy termination")[0];
      expect(activity?.activityId).toBeTruthy();
      expect(activity?.assets[0]).toMatchObject({
        kind: "document",
        origin: "user_attached",
        displayName: "policy.txt",
      });

      now = new Date("2026-06-12T09:05:00.000Z");
      const input2 = memory.recordUserMessage("c1", "What about renewal in policy.txt?");
      const run2 = memory.createWorkRun("c1", input2);
      const secondResult = await agentLoop({
        provider: createProvider([
          {
            kind: "act",
            action: {
              mode: "sequential",
              calls: [
                {
                  id: "restore_policy",
                  tool: "activity_restore_assets",
                  input: {},
                  dependsOn: [],
                  purpose: "Restore the prior policy document from the resolved activity",
                },
                {
                  id: "query_policy_again",
                  tool: "document_query",
                  input: { query: "renewal" },
                  dependsOn: ["restore_policy"],
                  purpose: "Query the restored policy document",
                },
              ],
              allowedTools: ["activity_restore_assets", "document_query"],
              assertions: [],
            },
          },
          {
            kind: "reply",
            status: "completed",
            message: "Renewal happens automatically unless cancelled in writing.",
          },
        ]),
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: memory,
        inputHandle: input2,
        runHandle: run2,
        clientId: "c1",
        initialUserMessage: "What about renewal in policy.txt?",
        dataDir,
        systemContext: "test",
        documentStore,
        preparedAttachmentRegistry: registry,
      });

      expect(secondResult.status).toBe("completed");
      expect(secondResult.taskSummary?.activityId).toBe(activity?.activityId);
      expect(secondResult.taskSummary?.activityAssets?.[0]).toMatchObject({
        kind: "document",
        displayName: "policy.txt",
      });
      memory.queueTaskSummary("c1", {
        ...secondResult.taskSummary!,
        sessionId: run2.sessionId,
      });

      const updated = memory.getActivityStore().getActivity(activity!.activityId);
      expect(updated?.runs.map((run) => run.runId)).toEqual([run1.runId, run2.runId]);
      expect(updated?.assets).toHaveLength(1);
      expect(updated?.assets[0]?.lastUsedRunId).toBe(run2.runId);
      expect(registry.getRunAttachments(run2.runId)[0]?.summary.displayName).toBe("policy.txt");
    } finally {
      await memory.shutdown();
      cleanup();
    }
  });
});
