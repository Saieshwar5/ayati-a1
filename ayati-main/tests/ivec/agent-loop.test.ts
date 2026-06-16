import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { noopSessionMemory } from "../../src/memory/provider.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";

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
        {
          kind: "reply",
          status: "completed",
          message: `I created the requested file at ${outputPath}.`,
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
      expect(result.totalIterations).toBe(2);
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(readFileSync(outputPath, "utf-8")).toBe("created by harness");
      expect(result.content).toContain(outputPath);
      expect(result.content).not.toContain("Done -");
      expect(result.content).not.toContain("deterministic verification");
      expect(result.content).not.toContain("Evidence:");
    } finally {
      cleanup(dataDir);
    }
  });

  it("returns the model-authored final reply after verified tool work", async () => {
    const dataDir = makeTmpDir();
    const indexPath = join(dataDir, "story-site", "index.html");
    const cssPath = join(dataDir, "story-site", "styles.css");
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
                createDirs: true,
                files: [
                  {
                    path: indexPath,
                    content: [
                      "<!doctype html>",
                      "<html>",
                      "<head><title>Luna and the Moon Garden</title></head>",
                      "<body>",
                      "<h1>Luna and the Moon Garden</h1>",
                      "<p>Luna planted a silver seed and found a tiny garden glowing under her window.</p>",
                      "</body>",
                      "</html>",
                    ].join("\n"),
                  },
                  {
                    path: cssPath,
                    content: "body { font-family: sans-serif; }",
                  },
                ],
              },
              dependsOn: [],
              purpose: "Create the requested kids story website",
            }],
            allowedTools: ["write_files"],
            maxCalls: 1,
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `I created the requested website files. The main file is ${indexPath}. The story page is ready to open.`,
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: noopSessionMemory,
        runHandle: { sessionId: "s1", runId: "r-story" },
        clientId: "c1",
        initialUserMessage: "Can you create a small website which will have small story for kids",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe(`I created the requested website files. The main file is ${indexPath}. The story page is ready to open.`);
      expect(result.content).not.toContain("tool call");
      expect(result.content).not.toContain("deterministic verification");
      expect(result.content).not.toContain("Evidence:");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(existsSync(indexPath)).toBe(true);
      expect(existsSync(cssPath)).toBe(true);
    } finally {
      cleanup(dataDir);
    }
  });

  it("feeds bounded session memory through the structured context pack", async () => {
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
          recentExchanges: [{
            runId: "old-run",
            user: {
              timestamp: "2026-06-12T09:00:00.000Z",
              content: "Build a todo app",
            },
            assistant: {
              timestamp: "2026-06-12T09:01:00.000Z",
              content: "Created the todo app.",
            },
          }, {
            runId: "r-context",
            user: {
              timestamp: "2026-06-12T09:10:00.000Z",
              content: "make it responsive too",
            },
          }],
          conversationTurns: [
            { role: "user", content: "Build a todo app", timestamp: "2026-06-12T09:00:00.000Z", sessionPath: "sessions/s1.md", runId: "old-run" },
            { role: "assistant", content: "Created the todo app.", timestamp: "2026-06-12T09:01:00.000Z", sessionPath: "sessions/s1.md", runId: "old-run" },
          ],
          previousSessionSummary: "Earlier work created the todo app shell.",
          personalMemorySnapshot: "- Prefers concise implementation notes.",
          activeFocus: [{
            focusId: "focus_todo",
            scope: "global",
            type: "artifact_work",
            status: "active",
            label: "todo app",
            summary: "Created todo app shell.",
            hints: ["todo app", "responsive"],
            topArtifacts: ["todo/index.html"],
            openWork: ["make responsive"],
            lastTouchedAt: "2026-06-12T09:01:00.000Z",
            lastTouchedLabel: "10m ago",
            attentionScore: 0.92,
            activatedAt: "2026-06-12T09:09:00.000Z",
            activatedReason: "current follow-up",
          }],
          attentionShelf: [{
            focusId: "focus_todo",
            scope: "global",
            type: "artifact_work",
            status: "warm",
            label: "todo app",
            summary: "Created todo app shell.",
            hints: ["todo app", "responsive"],
            topArtifacts: ["todo/index.html"],
            openWork: ["make responsive"],
            lastTouchedAt: "2026-06-12T09:01:00.000Z",
            lastTouchedLabel: "10m ago",
            attentionScore: 0.82,
          }],
          sessionFocusCards: [{
            focusId: "focus_todo_session",
            scope: "session",
            sessionId: "s1",
            type: "artifact_work",
            status: "active",
            label: "todo app",
            summary: "Wrote initial files.",
            hints: ["todo app"],
            topArtifacts: ["todo/index.html"],
            openWork: ["make responsive"],
            lastTouchedAt: "2026-06-12T09:01:00.000Z",
            lastTouchedLabel: "10m ago",
            attentionScore: 0.88,
          }],
          activeAttachments: [],
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
      });

      const callInput = generateTurn.mock.calls[0]?.[0];
      const userPrompt = callInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateJson = userPrompt.slice(
        userPrompt.indexOf("State view:\n") + "State view:\n".length,
        userPrompt.indexOf("\n\nSelected tools:"),
      );
      const stateView = JSON.parse(stateJson);
      expect(stateView.userMessage).toBeUndefined();
      expect(stateView.goal).toBeUndefined();
      expect(stateView.progress).toBeUndefined();
      expect(stateView.workState).toBeUndefined();
      expect(stateView.lastActions).toBeUndefined();
      expect(stateView.attachments).toBeUndefined();
      expect(stateView.runPath).toBeUndefined();
      expect(stateView.context.currentInput).toBe("make it responsive too");
      expect(stateView.context.runtime).toBeUndefined();
      expect(stateView.context.session).toBeUndefined();
      expect(stateView.context.recentSystemActivity).toBeUndefined();
      expect(stateView.context.activeFocus[0].focusId).toBe("focus_todo");
      expect(stateView.context.attentionShelf[0].focusId).toBe("focus_todo");
      expect(stateView.context.recentConversation).toHaveLength(1);
      expect(stateView.context.recentConversation[0].user.content).toBe("Build a todo app");
      expect(stateView.context.recentConversation[0].runId).toBe("old-run");
      expect(stateView.context.recentActivity).toBeUndefined();
      expect(stateView.context.recentExact).toBeUndefined();
      expect(stateView.context.recentTasks).toBeUndefined();
      expect(stateView.context.sessionFocusCards[0].openWork).toEqual(["make responsive"]);
      expect(stateView.context.previousSessionSummary).toContain("todo app shell");
      expect(stateView.context.personalMemorySnapshot).toContain("concise");
    } finally {
      cleanup(dataDir);
    }
  });

  it("feeds recent output context cards and evidence refs into the next decision", async () => {
    const dataDir = makeTmpDir();
    try {
      const shellTool: ToolDefinition = {
        name: "shell",
        description: "Run shell command",
        annotations: {
          domain: "shell",
          readOnly: true,
          mutatesWorkspace: false,
          mutatesExternalWorld: false,
          destructive: false,
          idempotent: true,
          retrySafe: true,
          longRunning: false,
        },
        async execute(input) {
          const cmd = typeof input === "object" && input !== null
            ? String((input as Record<string, unknown>)["cmd"] ?? "")
            : "";
          if (cmd.includes("ps")) {
            return {
              ok: true,
              output: "PID USER %MEM RSS COMMAND\n100 sai 5.3 416820 chromium\n200 sai 5.2 407288 code\n300 sai 3.0 239548 node",
            };
          }
          return {
            ok: true,
            output: "Mem: 7.4Gi total, 3.5Gi used, 3.8Gi available",
          };
        },
      };
      const toolExecutor = createToolExecutor([shellTool]);
      const generateTurn = vi.fn()
        .mockResolvedValueOnce({
          type: "assistant",
          content: JSON.stringify({
            kind: "act",
            action: {
              mode: "parallel",
              calls: [
                {
                  id: "call_1",
                  tool: "shell",
                  input: { cmd: "free -h" },
                  dependsOn: [],
                  purpose: "Get RAM summary",
                },
                {
                  id: "call_2",
                  tool: "shell",
                  input: { cmd: "ps axo pid,user,%mem,rss,comm --sort=-%mem | head -n 20" },
                  dependsOn: [],
                  purpose: "List top RAM processes",
                },
              ],
              allowedTools: ["shell"],
              maxCalls: 2,
            },
          }),
        })
        .mockResolvedValueOnce({
          type: "assistant",
          content: JSON.stringify({
            kind: "reply",
            status: "completed",
            message: "RAM used is 3.5Gi and chromium/code/node are the top RAM consumers.",
            workingNotes: ["Fetching current free RAM and per-process memory consumption."],
          }),
        });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { structuredOutput: { jsonObject: true } },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn,
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        sessionMemory: noopSessionMemory,
        runHandle: { sessionId: "s1", runId: "r-observation" },
        clientId: "c1",
        initialUserMessage: "what is my ram usage and what programs are using it?",
        dataDir,
        systemContext: "static decision context",
      });

      expect(result.status).toBe("completed");
      expect(generateTurn).toHaveBeenCalledTimes(2);
      const secondCallInput = generateTurn.mock.calls[1]?.[0];
      const userPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateJson = userPrompt.slice(
        userPrompt.indexOf("State view:\n") + "State view:\n".length,
        userPrompt.indexOf("\n\nSelected tools:"),
      );
      const stateView = JSON.parse(stateJson);
      expect(stateView.toolContext.recent).toHaveLength(2);
      expect(stateView.toolContext.recent[0].purpose).toBe("Get RAM summary");
      expect(stateView.toolContext.recent[0].content).toContain("3.5Gi used");
      expect(stateView.toolContext.recent[0].evidenceRef).toBe("evidence://ev_001_call_1");
      expect(stateView.toolContext.recent[1].purpose).toBe("List top RAM processes");
      expect(stateView.toolContext.recent[1].content).toContain("chromium");
      expect(stateView.toolContext.recent[1].evidenceRef).toBe("evidence://ev_001_call_2");
      expect(stateView.latestObservation.evidenceRef).toBe("evidence://ev_001_call_2");
      expect(stateView.workState.evidenceRefs[0].ref).toBe("evidence://ev_001_call_1");
      expect(stateView.workState.evidenceRefs[1].ref).toBe("evidence://ev_001_call_2");
      expect(stateView.workingNotes).toBeUndefined();
      expect(userPrompt).toContain("evidence_search");
      expect(existsSync(join(dataDir, "runs", "r-observation", "raw", "001-call_1-shell-output.txt"))).toBe(true);
      expect(existsSync(join(dataDir, "runs", "r-observation", "raw", "001-call_2-shell-output.txt"))).toBe(true);
      const persisted = JSON.parse(readFileSync(join(dataDir, "runs", "r-observation", "state.json"), "utf-8"));
      expect(persisted.toolContext.recent).toHaveLength(2);
      expect(persisted.workingNotes).toBeUndefined();
    } finally {
      cleanup(dataDir);
    }
  });
});
