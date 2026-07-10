import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import { noopRunRecorder } from "../../src/ivec/noop-run-recorder.js";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { GitMemoryStepRecord } from "../../src/context-engine/index.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";

const originalWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env["AYATI_WORKSPACE_DIR"];
  } else {
    process.env["AYATI_WORKSPACE_DIR"] = originalWorkspaceDir;
  }
});

function makeTmpDir(): string {
  const path = mkdtempSync(join(tmpdir(), "ayati-run-tool-recovery-"));
  process.env["AYATI_WORKSPACE_DIR"] = path;
  return path;
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function skill(id: string, tools: ToolDefinition[]): SkillDefinition {
  return {
    id,
    version: "1.0.0",
    description: `${id} skill`,
    promptBlock: "",
    tools,
  };
}

function extractStateView(userPrompt: string): any {
  const marker = "State view:\n";
  const start = userPrompt.indexOf(marker);
  if (start < 0) {
    throw new Error("State view section missing from decision prompt.");
  }
  return JSON.parse(userPrompt.slice(start + marker.length).trim());
}

function userPrompt(input: { messages: Array<{ role: string; content: string }> }): string {
  const message = input.messages.find((entry) => entry.role === "user");
  if (!message) {
    throw new Error("User prompt missing from provider input.");
  }
  return message.content;
}

function createProvider(
  handlers: Array<(input: Parameters<LlmProvider["generateTurn"]>[0]) => unknown>,
): LlmProvider {
  const queue = [...handlers];
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true } },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn().mockImplementation(async (input: Parameters<LlmProvider["generateTurn"]>[0]) => {
      const handler = queue.shift();
      if (!handler) {
        throw new Error("No queued provider response");
      }
      const response = handler(input);
      return {
        type: "assistant",
        content: typeof response === "string" ? response : JSON.stringify(response),
      };
    }),
  };
}

function fakeReadFileTool(): ToolDefinition {
  return {
    name: "read_files",
    description: "Read a file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    annotations: {
      domain: "filesystem",
      readOnly: true,
      mutatesWorkspace: false,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: true,
      retrySafe: true,
      longRunning: false,
    },
    observationPolicy: {
      outputImportance: "decision_context",
      rawStorage: "always",
      maxObservationChars: 20_000,
    },
    async execute(input) {
      const path = typeof input === "object" && input && "path" in input
        ? String((input as { path: unknown }).path)
        : "unknown";
      const output = `FULL_OUTPUT_${path}\n${"context-line\n".repeat(1_800)}`;
      return {
        ok: true,
        output,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "READ_FILE_OK",
          message: `Read ${path}`,
          structuredContent: { path, output },
        },
      };
    },
  };
}

function fakePressureReadTool(): ToolDefinition {
  return {
    name: "read_files",
    description: "Read a large file for context pressure testing.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    annotations: {
      domain: "filesystem",
      readOnly: true,
      mutatesWorkspace: false,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: true,
      retrySafe: true,
      longRunning: false,
    },
    observationPolicy: {
      outputImportance: "decision_context",
      rawStorage: "always",
      maxObservationChars: 70_000,
    },
    async execute(input) {
      const path = typeof input === "object" && input && "path" in input
        ? String((input as { path: unknown }).path)
        : "unknown";
      const output = `PRESSURE_OUTPUT_${path}\n${"context-pressure-line\n".repeat(3_000)}`;
      return {
        ok: true,
        output,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "READ_FILE_OK",
          message: `Read ${path}`,
          structuredContent: { path, outputChars: output.length },
        },
      };
    },
  };
}

function fakeWriteFilesTool(): ToolDefinition {
  return {
    name: "write_files",
    description: "Write files.",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array" },
      },
    },
    annotations: {
      domain: "filesystem",
      readOnly: false,
      mutatesWorkspace: true,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: true,
      retrySafe: true,
      longRunning: false,
    },
    async execute(input) {
      const files = typeof input === "object" && input && "files" in input
        ? (input as { files: unknown }).files
        : [];
      const firstFile = Array.isArray(files) ? files[0] : undefined;
      const path = typeof firstFile === "object" && firstFile && "path" in firstFile
        ? String((firstFile as { path: unknown }).path)
        : "unknown";
      return {
        ok: true,
        output: `WROTE_${path}`,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "FILES_WRITTEN",
          message: `Wrote ${path}`,
          structuredContent: { files: [{ path }] },
        },
      };
    },
  };
}

function fakeRunStepRecoveryTool(records: GitMemoryStepRecord[]): ToolDefinition {
  return {
    name: "git_context_read_run_step",
    description: "Recover a persisted run step or tool call.",
    inputSchema: {
      type: "object",
      required: ["runId", "step"],
      properties: {
        runId: { type: "string" },
        step: { type: "integer" },
        callId: { type: "string" },
      },
    },
    annotations: {
      domain: "git_context",
      readOnly: true,
      mutatesWorkspace: false,
      mutatesExternalWorld: false,
      destructive: false,
      idempotent: true,
      retrySafe: true,
      longRunning: false,
    },
    async execute(input) {
      const data = input as { runId: string; step: number; callId?: string };
      const record = records.find((entry) => entry.runId === data.runId && entry.step === data.step);
      const toolCall = record?.toolCalls.find((entry) => entry.callId === data.callId);
      if (!record || !toolCall) {
        return {
          ok: false,
          error: `Missing stepRef ${data.runId}:${data.step}:${data.callId ?? ""}`,
        };
      }
      const structuredContent = { record, toolCall };
      return {
        ok: true,
        output: JSON.stringify(structuredContent, null, 2),
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "RUN_STEP_READ_OK",
          message: "Recovered run step.",
          structuredContent,
        },
      };
    },
  };
}

describe("run tool-call context", () => {
  it("keeps every prompt-eligible tool call full below the soft limit", async () => {
    const dataDir = makeTmpDir();
    const records: GitMemoryStepRecord[] = [];
    const readTool = fakeReadFileTool();
    const writeTool = fakeWriteFilesTool();
    const recoveryTool = fakeRunStepRecoveryTool(records);
    const toolExecutor = createToolExecutor([]);
    const catalog = new ToolCatalog([
      skill("filesystem", [readTool, writeTool]),
      skill("git-context", [recoveryTool]),
    ]);
    const toolWorkingSetManager = new ToolWorkingSetManager({
      catalog,
      toolExecutor,
      maxVisibleTools: 15,
    });

    const provider = createProvider([
      () => ({
        kind: "act",
        action: {
          mode: "sequential",
          calls: [1, 2, 3, 4].map((index) => ({
            id: `call_${index}`,
            tool: "read_files",
            input: { path: `file_${index}.txt` },
            purpose: `Read file ${index}`,
          })),
          allowedTools: ["read_files"],
          completion: { expected: "Read enough files to build context." },
          assertions: [],
        },
      }),
      () => ({
        kind: "act",
        action: {
          mode: "single",
            calls: [{
              id: "call_5",
              tool: "write_files",
              input: { files: [{ path: "marker.txt", content: "marker" }] },
              purpose: "Create marker output",
            }],
          allowedTools: ["write_files"],
          completion: { expected: "Create a marker file." },
          assertions: [],
        },
      }),
      (input) => {
        const stateView = extractStateView(userPrompt(input));
        const toolCalls = stateView.context.run.toolCalls;
        expect(toolCalls).toHaveLength(5);
        expect(toolCalls[0]).toMatchObject({
          callId: "call_1",
          tool: "read_files",
          mode: "full",
          output: expect.stringContaining("FULL_OUTPUT_file_1.txt"),
          stepRef: { runId: "r-recovery", step: 1, callId: "call_1" },
        });
        expect(toolCalls.every((entry: { mode: string }) => entry.mode === "full")).toBe(true);
        expect(stateView.context.tools.active).toContain("git_context_read_run_step");
        return {
          kind: "reply",
          status: "completed",
          message: "Retained the complete tool context and completed the task.",
        };
      },
    ]);

    try {
      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [],
        toolWorkingSetManager,
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s-recovery", runId: "r-recovery" },
        inputHandle: { sessionId: "s-recovery", seq: 1 },
        clientId: "c-recovery",
        initialUserMessage: "Read these files, write a marker file, then recover any compacted run step if needed.",
        dataDir,
        systemContext: "system context",
        config: {
          maxInlineActOutputChars: 20_000,
        },
        harnessContext: {
          contextEngine: {
            session: {
              meta: { sessionId: "s-recovery", assetCount: 0 },
              conversationTail: [],
              activityTail: [],
            },
            focus: {
              status: "active",
              ref: "refs/heads/task/T-RECOVERY",
              workId: "T-RECOVERY",
            },
            task: {
              ref: "refs/heads/task/T-RECOVERY",
              workId: "T-RECOVERY",
              title: "Recovery test",
              objective: "Validate compacted tool-call recovery.",
              status: "active",
              completed: [],
              open: ["Recover compacted output."],
              blockers: [],
              facts: [],
              assets: [],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
        recordTaskStep: (record) => {
          records.push(record);
        },
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Retained the complete tool context and completed the task.");
      expect(records).toHaveLength(2);
      expect(records[0]?.toolCalls[0]).toMatchObject({
        callId: "call_1",
        tool: "read_files",
        output: expect.stringContaining("FULL_OUTPUT_file_1.txt"),
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("ends the current run when deterministic recovery remains above the soft limit", async () => {
    const dataDir = makeTmpDir();
    const readTool = fakePressureReadTool();
    const toolExecutor = createToolExecutor([readTool]);
    const provider = createProvider([
      () => ({
        kind: "act",
        action: {
          mode: "sequential",
          calls: Array.from({ length: 7 }, (_, index) => ({
            id: `call_${index + 1}`,
            tool: "read_files",
            input: { path: `pressure_${index + 1}.txt` },
            purpose: `Read pressure fixture ${index + 1}`,
          })),
          allowedTools: ["read_files"],
          assertions: [],
        },
      }),
    ]);
    provider.countInputTokens = vi.fn(async (input) => {
      const toolCalls = extractStateView(userPrompt(input)).context.run?.toolCalls ?? [];
      const hasProjection = toolCalls.some((call: { mode: string }) => call.mode !== "full");
      return {
        provider: "mock",
        model: "1.0.0",
        inputTokens: hasProjection ? 75_000 : 80_000,
        exact: true,
      };
    });

    try {
      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s-pressure", runId: "r-pressure" },
        clientId: "c-pressure",
        initialUserMessage: "Read the pressure fixtures and report when enough context is available.",
        dataDir,
        systemContext: "system context",
        config: {
          maxTotalToolCallsPerStep: 8,
          maxSequentialToolCallsPerStep: 8,
          maxInlineActOutputChars: 100_000,
          toolContextProjectionPolicy: "enforce",
        },
      });

      expect(result.status).toBe("stuck");
      expect(result.totalIterations).toBe(2);
      expect(result.totalToolCalls).toBe(7);
      expect(result.content).toBe(
        "This run reached its context capacity. I preserved the completed work and task state so it can continue in a new turn.",
      );
      expect(result.taskSummary).toMatchObject({
        runStatus: "stuck",
        taskStatus: "open",
        stopReason: "context_limit",
      });
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(provider.countInputTokens).toHaveBeenCalled();
    } finally {
      cleanup(dataDir);
    }
  });
});
