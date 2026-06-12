import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { noopSessionMemory } from "../../src/memory/provider.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-agent-loop-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function createProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map((response) => typeof response === "string" ? response : JSON.stringify(response));
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

describe("agentLoop", () => {
  it("uses the single decision stage for direct replies", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Hello from the redesigned loop." },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory: noopSessionMemory,
        runHandle: { sessionId: "s1", runId: "r1" },
        clientId: "c1",
        initialUserMessage: "hello",
        dataDir,
        systemContext: "full system context",
      });

      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("interaction");
      expect(result.totalIterations).toBe(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(result.content).toBe("Hello from the redesigned loop.");
    } finally {
      cleanup(dataDir);
    }
  });

  it("executes deterministic tool actions without an understand/direct/verify stack", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "todo.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                files: [{ path: outputPath, content: "created by harness" }],
              },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
            maxCalls: 1,
            assertions: [],
          },
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: noopSessionMemory,
        runHandle: { sessionId: "s1", runId: "r2" },
        clientId: "c1",
        initialUserMessage: `Create ${outputPath}`,
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("task");
      expect(result.totalIterations).toBe(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(readFileSync(outputPath, "utf-8")).toBe("created by harness");
      expect(result.content).toContain("Done -");
    } finally {
      cleanup(dataDir);
    }
  });

  it("feeds bounded runtime memory through the structured context pack", async () => {
    const dataDir = makeTmpDir();
    try {
      const generateTurn = vi.fn().mockResolvedValue({
        type: "assistant",
        content: JSON.stringify({ kind: "reply", status: "completed", message: "context received" }),
      });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { structuredOutput: { jsonObject: true } },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn,
      };
      const sessionMemory = {
        ...noopSessionMemory,
        getPromptMemoryContext: vi.fn().mockReturnValue({
          conversationTurns: [
            { role: "user", content: "Build a todo app", timestamp: "2026-06-12T09:00:00.000Z", sessionPath: "sessions/s1.md", runId: "old-run" },
            { role: "assistant", content: "Created the todo app.", timestamp: "2026-06-12T09:01:00.000Z", sessionPath: "sessions/s1.md", runId: "old-run" },
          ],
          previousSessionSummary: "Earlier work created the todo app shell.",
          personalMemorySnapshot: "- Prefers concise implementation notes.",
          attentionShelf: [{
            focusId: "focus_todo",
            type: "artifact_work",
            status: "warm",
            label: "todo app",
            summary: "Created todo app shell.",
            hints: ["todo app", "responsive"],
            topArtifacts: ["todo/index.html"],
            lastTouchedAt: "2026-06-12T09:01:00.000Z",
            lastTouchedLabel: "10m ago",
            attentionScore: 0.82,
          }],
          activeSessionPath: "sessions/s1.md",
          recentTaskSummaries: [{
            timestamp: "2026-06-12T09:01:00.000Z",
            runId: "old-run",
            runPath: "data/runs/old-run",
            runStatus: "completed",
            taskStatus: "likely_done",
            objective: "Create todo app",
            summary: "Created todo app shell.",
            progressSummary: "Wrote initial files.",
            completedMilestones: ["write_files completed"],
            openWork: ["make responsive"],
            blockers: [],
            keyFacts: ["todo/index.html exists"],
            evidence: ["write_files verified"],
            attachmentNames: [],
          }],
          activeAttachments: [],
          recentSystemActivity: [],
        }),
        getSessionStatus: vi.fn().mockReturnValue({
          contextPercent: 12,
          turns: 2,
          sessionAgeMinutes: 10,
          startedAt: "2026-06-12T09:00:00.000Z",
          handoffPhase: "inactive",
          pendingRotationReason: null,
        }),
      };

      await agentLoop({
        provider,
        toolDefinitions: [],
        sessionMemory,
        runHandle: { sessionId: "s1", runId: "r-context" },
        clientId: "c1",
        initialUserMessage: "make it responsive too",
        dataDir,
        systemContext: "static decision context",
        runtimeContext: {
          nowUtc: "2026-06-12T03:40:00.000Z",
          timezone: "Asia/Kolkata",
          localDate: "2026-06-12",
          localTime: "09:10",
          weekday: "Friday",
        },
      });

      const callInput = generateTurn.mock.calls[0]?.[0];
      const userPrompt = callInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateJson = userPrompt.slice(
        userPrompt.indexOf("State view:\n") + "State view:\n".length,
        userPrompt.indexOf("\n\nSelected tools:"),
      );
      const stateView = JSON.parse(stateJson);
      expect(stateView.context.currentInput).toBe("make it responsive too");
      expect(stateView.context.runtime.localDate).toBe("2026-06-12");
      expect(stateView.context.session.activeSessionPath).toBe("sessions/s1.md");
      expect(stateView.context.session.contextPercent).toBe(12);
      expect(stateView.context.attentionShelf[0].focusId).toBe("focus_todo");
      expect(stateView.context.recentExact).toHaveLength(2);
      expect(stateView.context.recentTasks[0].openWork).toEqual(["make responsive"]);
      expect(stateView.context.previousSessionSummary).toContain("todo app shell");
      expect(stateView.context.personalMemorySnapshot).toContain("concise");
    } finally {
      cleanup(dataDir);
    }
  });
});
