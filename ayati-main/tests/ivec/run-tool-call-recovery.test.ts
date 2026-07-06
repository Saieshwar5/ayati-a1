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
    name: "read_file",
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
    async execute(input) {
      const path = typeof input === "object" && input && "path" in input
        ? String((input as { path: unknown }).path)
        : "unknown";
      const output = `FULL_OUTPUT_${path}\n${"context-line ".repeat(120)}`;
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

function fakeWriteFileTool(): ToolDefinition {
  return {
    name: "write_file",
    description: "Write a file.",
    inputSchema: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
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
      const path = typeof input === "object" && input && "path" in input
        ? String((input as { path: unknown }).path)
        : "unknown";
      return {
        ok: true,
        output: `WROTE_${path}`,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "WRITE_FILE_OK",
          message: `Wrote ${path}`,
          structuredContent: { path },
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

describe("run tool-call recovery", () => {
  it("selects the run-step recovery tool and recovers full output from a compacted stepRef", async () => {
    const dataDir = makeTmpDir();
    const records: GitMemoryStepRecord[] = [];
    const readTool = fakeReadFileTool();
    const writeTool = fakeWriteFileTool();
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
            tool: "read_file",
            input: { path: `file_${index}.txt` },
            purpose: `Read file ${index}`,
          })),
          allowedTools: ["read_file"],
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
            tool: "write_file",
            input: { path: "marker.txt", content: "marker" },
            purpose: "Create marker output",
          }],
          allowedTools: ["write_file"],
          completion: { expected: "Create a marker file." },
          assertions: [],
        },
      }),
      (input) => {
        const stateView = extractStateView(userPrompt(input));
        const toolCalls = stateView.context.run.toolCalls;
        expect(toolCalls).toHaveLength(5);
        expect(toolCalls[0]).toMatchObject({
          mode: "summary",
          callId: "call_1",
          tool: "read_file",
          outputCompacted: true,
          stepRef: { runId: "r-recovery", step: 1, callId: "call_1" },
        });
        expect(toolCalls[0].output).toBeUndefined();
        expect(toolCalls[0].outputPreview).toContain("FULL_OUTPUT_file_1.txt");
        expect(stateView.context.tools.active).toContain("git_context_read_run_step");
        return {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_recover_1",
              tool: "git_context_read_run_step",
              input: toolCalls[0].stepRef,
              purpose: "Recover compacted read output.",
            }],
            allowedTools: ["git_context_read_run_step"],
            completion: { expected: "Recover the exact first read output." },
            assertions: [],
          },
        };
      },
      (input) => {
        const stateView = extractStateView(userPrompt(input));
        const recoveryCall = stateView.context.run.toolCalls.find(
          (entry: { callId?: string }) => entry.callId === "call_recover_1",
        );
        expect(recoveryCall).toMatchObject({
          mode: "full",
          tool: "git_context_read_run_step",
          status: "success",
        });
        expect(recoveryCall.output).toContain("FULL_OUTPUT_file_1.txt");
        return {
          kind: "reply",
          status: "completed",
          message: "Recovered the compacted read output and completed the task.",
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
      expect(result.content).toBe("Recovered the compacted read output and completed the task.");
      expect(records).toHaveLength(3);
      expect(records[0]?.toolCalls[0]).toMatchObject({
        callId: "call_1",
        tool: "read_file",
        output: expect.stringContaining("FULL_OUTPUT_file_1.txt"),
      });
    } finally {
      cleanup(dataDir);
    }
  });
});
