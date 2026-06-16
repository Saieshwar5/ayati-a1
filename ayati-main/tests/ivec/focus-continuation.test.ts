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
import { createAttachmentSkill } from "../../src/skills/builtins/attachments/index.js";
import { createDocumentSkill } from "../../src/skills/builtins/documents/index.js";
import { createFocusSkill } from "../../src/skills/builtins/focus/index.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

const tempDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ayati-focus-continuation-"));
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
    capabilities: { structuredOutput: { jsonObject: true } },
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

describe("focus continuation in the agent loop", () => {
  it("restores a user-attached document from the focus card in a later run", async () => {
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
        sessionMemory: memory,
        preparedAttachmentRegistry: registry,
        dataDir,
      });
      const tools = [
        ...createFocusSkill({ store: memory.getFocusStore(), defaultClientId: "c1" }).tools,
        ...createAttachmentSkill({ sessionAttachmentService }).tools,
        ...createDocumentSkill({ preparedAttachmentService }).tools,
      ];
      const toolExecutor = createToolExecutor(tools);
      const registered = await documentStore.registerAttachments([{ path: policyPath, name: "policy.txt" }]);

      const run1 = memory.beginRun("c1", "What does the policy say about termination?");
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
              maxCalls: 1,
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
        runHandle: run1,
        clientId: "c1",
        initialUserMessage: "What does the policy say about termination?",
        dataDir,
        systemContext: "test",
        attachedDocuments: registered.documents,
        documentStore,
        preparedAttachmentRegistry: registry,
      });

      expect(firstResult.taskSummary?.focusAssets?.[0]).toMatchObject({
        kind: "document",
        origin: "user_attached",
        role: "input",
        displayName: "policy.txt",
      });
      memory.queueTaskSummary("c1", {
        ...firstResult.taskSummary!,
        sessionId: run1.sessionId,
      });

      const focusId = memory.getPromptMemoryContext().sessionFocusCards?.[0]?.focusId;
      expect(focusId).toBeTruthy();
      const firstCard = memory.getFocusStore().getFocus(focusId!);
      expect(firstCard?.assets[0]).toMatchObject({
        kind: "document",
        origin: "user_attached",
        displayName: "policy.txt",
      });
      expect(memory.getActiveAttachmentRecords()).toHaveLength(1);

      now = new Date("2026-06-12T09:05:00.000Z");
      const run2 = memory.beginRun("c1", "What about renewal in that document?");
      const secondResult = await agentLoop({
        provider: createProvider([
          {
            kind: "act",
            action: {
              mode: "sequential",
              calls: [
                {
                  id: "activate_focus",
                  tool: "focus_activate",
                  input: { focusId, reason: "follow-up about the same policy document" },
                  dependsOn: [],
                  purpose: "Activate the previous policy focus card",
                },
                {
                  id: "restore_policy",
                  tool: "restore_attachment_context",
                  input: {},
                  dependsOn: ["activate_focus"],
                  purpose: "Restore the prior document into this run",
                },
                {
                  id: "query_policy_again",
                  tool: "document_query",
                  input: { query: "renewal" },
                  dependsOn: ["restore_policy"],
                  purpose: "Query the restored policy document",
                },
              ],
              allowedTools: ["focus_activate", "restore_attachment_context", "document_query"],
              maxCalls: 3,
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
        runHandle: run2,
        clientId: "c1",
        initialUserMessage: "What about renewal in that document?",
        dataDir,
        systemContext: "test",
        documentStore,
        preparedAttachmentRegistry: registry,
      });

      expect(secondResult.status).toBe("completed");
      expect(secondResult.taskSummary?.focusId).toBe(focusId);
      expect(secondResult.taskSummary?.focusAssets?.[0]).toMatchObject({
        kind: "document",
        displayName: "policy.txt",
      });
      memory.queueTaskSummary("c1", {
        ...secondResult.taskSummary!,
        sessionId: run2.sessionId,
      });

      const updated = memory.getFocusStore().getFocus(focusId!);
      expect(updated?.focusId).toBe(focusId);
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
