import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRunHandle } from "ayati-git-context";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { ContextRunStepRecord } from "../../src/context-engine/index.js";
import type { HarnessContextInput } from "../../src/ivec/harness-context.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";
import { noopRunRecorder } from "../../src/ivec/noop-run-recorder.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { nativeDecisionFixture } from "./native-decision-fixture.js";

const originalWorkspaceDir = process.env["AYATI_WORKSPACE_DIR"];

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env["AYATI_WORKSPACE_DIR"];
  } else {
    process.env["AYATI_WORKSPACE_DIR"] = originalWorkspaceDir;
  }
});

function makeTmpDir(): string {
  const path = mkdtempSync(join(tmpdir(), "ayati-agent-loop-"));
  process.env["AYATI_WORKSPACE_DIR"] = path;
  return path;
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function runHandle(runId: string, triggerSeq = 1): AgentRunHandle {
  return {
    runId,
    sessionId: "s1",
    conversationId: `C-${runId}`,
    triggerSeq,
  };
}

function baseContext(): HarnessContextInput {
  return {
    contextEngine: {
      session: {
        meta: { sessionId: "s1", assetCount: 0 },
        conversationTail: [],
        activityTail: [],
      },
      focus: { status: "none" },
    },
  };
}

function unboundContext(runId: string, text: string): HarnessContextInput {
  const context = baseContext().contextEngine!;
  return {
    contextEngine: {
      ...context,
      pendingTurn: {
        fromSeq: 1,
        toSeq: 1,
        text,
        at: "2026-07-19T10:00:00.000Z",
        routingStatus: "unbound",
        runId,
      },
    },
  };
}

function boundContext(runId: string, text: string, workingDirectory?: string): HarnessContextInput {
  const taskId = "T-20260719-001";
  const branch = "task/T-20260719-001-one-run";
  const context = baseContext().contextEngine!;
  return {
    contextEngine: {
      ...context,
      pendingTurn: {
        fromSeq: 1,
        toSeq: 1,
        text,
        at: "2026-07-19T10:00:00.000Z",
        routingStatus: "bound",
        workId: taskId,
        branch,
        runId,
      },
      focus: {
        status: "active",
        ref: `refs/heads/${branch}`,
        workId: taskId,
      },
      task: {
        ...(workingDirectory ? { workingDirectory } : {}),
        ref: `refs/heads/${branch}`,
        workId: taskId,
        title: "One run test task",
        objective: text,
        status: "active",
        completed: [],
        open: [text],
        blockers: [],
        facts: [],
        next: text,
        assets: [],
        recentRuns: [],
        recentCommits: [],
        recentEvidence: [],
      },
    },
  };
}

function createProvider(responses: unknown[]): LlmProvider {
  const queue = responses.map(nativeDecisionFixture);
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: {
      nativeToolCalling: true,
      structuredOutput: { jsonObject: true, jsonSchema: true },
    },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi.fn(async (): Promise<LlmTurnOutput> => {
      const response = queue.shift();
      if (!response) throw new Error("No queued provider response");
      return response;
    }),
  };
}

function createMemoryFeedbackLedger(): {
  ledger: AgentFeedbackLedger;
  events: AgentFeedbackEventInput[];
} {
  const events: AgentFeedbackEventInput[] = [];
  return {
    events,
    ledger: {
      enabled: true,
      record(event) {
        events.push(event);
      },
      async flush() {},
      async close() {},
    },
  };
}

function extractStateView(userPrompt: string): Record<string, any> {
  const marker = "State view:\n";
  const start = userPrompt.indexOf(marker);
  if (start < 0) throw new Error("State view section missing from decision prompt");
  const raw = userPrompt.slice(start + marker.length).trim();
  const objectStart = raw.indexOf("{");
  if (objectStart < 0) throw new Error("State view JSON object missing");
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = objectStart; index < raw.length; index++) {
    const char = raw[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return JSON.parse(raw.slice(objectStart, index + 1));
    }
  }
  throw new Error("State view JSON object was incomplete");
}

function readTool(): ToolDefinition {
  return {
    name: "read_files",
    description: "Read a fixture file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    async execute() {
      return { ok: true, output: "upload handling lives in src/upload.ts" };
    },
  };
}

function createTaskTool(runId: string, workingDirectory: string): ToolDefinition {
  const taskId = "T-20260719-001";
  const taskRequestId = "REQ-20260719-001";
  const branch = "task/T-20260719-001-one-run";
  return {
    name: "git_context_create_task",
    description: "Bind the current run to a newly created task.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "createReason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        createReason: { type: "string" },
      },
    },
    async execute(_input, context) {
      expect(context).toMatchObject({
        runId,
        callId: "bind-task",
      });
      return {
        ok: true,
        output: `Created ${taskId} and bound ${runId}.`,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "GIT_CONTEXT_TURN_TASK_CREATED",
          message: "Created a task and bound the existing run.",
          structuredContent: {
            status: "ready",
            mode: "created",
            sessionId: "s1",
            taskId,
            taskRequestId,
            taskRequestStatus: "active",
            taskRequestCreated: true,
            requestDecision: "initial",
            taskCreated: true,
            branch,
            workingDirectory,
            taskHead: "0123456789abcdef",
            runId,
            harnessContext: boundContext(runId, "Create the requested file.", workingDirectory),
          },
        },
      };
    },
  };
}

function failingCreateTaskTool(): ToolDefinition {
  return {
    name: "git_context_create_task",
    description: "Fail to bind the current run for a persistence test.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "createReason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        createReason: { type: "string" },
      },
    },
    async execute() {
      return {
        ok: false,
        error: "Task creation failed deterministically.",
        v2: {
          transportOk: true,
          operationStatus: "failed",
          code: "GIT_CONTEXT_TASK_CREATE_FAILED",
          message: "Task creation failed deterministically.",
        },
      };
    },
  };
}

describe("agentLoop one-run lifecycle", () => {
  it("returns a direct zero-step reply for the prepared run", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Hello from one run." },
      ]);
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-direct"),
        recordRunStep,
        clientId: "c1",
        initialUserMessage: "hello",
        dataDir,
        systemContext: "test system context",
      });

      expect(result).toMatchObject({
        runId: "R-direct",
        outcome: "done",
        stopReason: "completed",
        status: "completed",
        totalIterations: 1,
        totalToolCalls: 0,
        content: "Hello from one run.",
      });
      expect(recordRunStep).not.toHaveBeenCalled();
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("records an observational step on the same unbound run", async () => {
    const dataDir = makeTmpDir();
    try {
      const tool = readTool();
      const toolExecutor = createToolExecutor([tool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "read-upload",
              tool: "read_files",
              input: { path: "src/upload.ts" },
              dependsOn: [],
              purpose: "Locate upload handling",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        { kind: "reply", status: "completed", message: "Upload handling is in src/upload.ts." },
      ]);
      const records: ContextRunStepRecord[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [tool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-read"),
        recordRunStep(record) {
          records.push(record);
        },
        clientId: "c1",
        initialUserMessage: "Where is upload handling?",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-read", "Where is upload handling?"),
      });

      expect(result).toMatchObject({
        runId: "R-read",
        outcome: "done",
        stopReason: "completed",
        totalToolCalls: 1,
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: "R-read",
        step: 1,
        status: "completed",
        toolCalls: [{ tool: "read_files", callId: "read-upload", status: "success" }],
      });

      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const prompt = secondInput.messages.find((message) => message.role === "user")?.content;
      expect(typeof prompt).toBe("string");
      const stateView = extractStateView(prompt as string);
      expect(Object.keys(stateView.context.run).sort()).toEqual(["toolCalls", "workState"]);
      expect(stateView.context.run).not.toHaveProperty("runId");
      expect(stateView.context.run).not.toHaveProperty("status");
      expect(stateView.context.run).not.toHaveProperty("routing");
      expect(stateView.context.run.toolCalls[0]).toMatchObject({
        tool: "read_files",
        purpose: "Locate upload handling",
        status: "success",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("rejects an unbound mutation and never defers or executes it", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "must-not-exist.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "stale-write",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "unsafe" }] },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        { kind: "reply", status: "completed", message: "I need to bind this run before mutation." },
      ]);
      const recordRunStep = vi.fn();

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [writeFilesTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-unbound-mutation"),
        recordRunStep,
        feedbackLedger: feedback.ledger,
        clientId: "c1",
        initialUserMessage: "Create a file",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-unbound-mutation", "Create a file"),
      });

      expect(result.runId).toBe("R-unbound-mutation");
      expect(existsSync(outputPath)).toBe(false);
      expect(recordRunStep).not.toHaveBeenCalled();
      const repairs = feedback.events.filter((event) => event.event === "repair_requested");
      expect(repairs[0]?.data?.["repair"]).toMatchObject({
        code: "R_MUTATION_REQUIRES_TASK_BINDING",
        blockedTargets: ["write_files"],
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("binds the existing run, refreshes context, and makes a fresh mutation decision", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "one-run.txt");
    const runId = "R-route-and-write";
    try {
      const routeTool = createTaskTool(runId, dataDir);
      const toolExecutor = createToolExecutor([routeTool, writeFilesTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "bind-task",
              tool: "git_context_create_task",
              input: {
                title: "One run file",
                objective: "Create one-run.txt",
                createReason: "no_active_task",
              },
              dependsOn: [],
              purpose: "Bind durable work to a task",
            }],
            allowedTools: ["git_context_create_task"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write-after-binding",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "same durable run" }] },
              dependsOn: [],
              purpose: "Create the requested file after binding",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: { summary: "Created and verified one-run.txt.", assets: [] },
        },
        { kind: "reply", status: "completed", message: "Created one-run.txt." },
      ]);
      const records: ContextRunStepRecord[] = [];
      const persistedContexts: HarnessContextInput[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [routeTool, writeFilesTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle(runId),
        recordRunStep(record, currentContext) {
          records.push(record);
          persistedContexts.push(currentContext);
        },
        clientId: "c1",
        initialUserMessage: "Create one-run.txt",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext(runId, "Create one-run.txt"),
      });

      expect(result).toMatchObject({
        runId,
        outcome: "done",
        stopReason: "completed",
        status: "completed",
      });
      expect(result.taskSummary).toMatchObject({
        runId,
        taskStatus: "done",
        stopReason: "completed",
      });
      expect(records.map((record) => [record.runId, record.step])).toEqual([
        [runId, 1],
        [runId, 2],
      ]);
      expect(records[0]?.toolCalls[0]).toMatchObject({ tool: "git_context_create_task", callId: "bind-task" });
      expect(records[1]?.toolCalls[0]).toMatchObject({ tool: "write_files", callId: "write-after-binding" });
      expect(persistedContexts).toHaveLength(2);
      expect(persistedContexts[0]?.contextEngine?.pendingTurn).toMatchObject({
        routingStatus: "bound",
        runId,
      });
      expect(persistedContexts[1]?.contextEngine?.pendingTurn).toMatchObject({
        routingStatus: "bound",
        runId,
      });
      expect(readFileSync(outputPath, "utf8")).toBe("same durable run");

      const firstInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const secondInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      expect(firstInput.tools.map((tool) => tool.name)).toContain("git_context_create_task");
      expect(firstInput.tools.map((tool) => tool.name)).not.toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).toContain("write_files");
      expect(secondInput.tools.map((tool) => tool.name)).not.toContain("git_context_create_task");
    } finally {
      cleanup(dataDir);
    }
  });

  it("persists a failed routing control step before terminal failure", async () => {
    const dataDir = makeTmpDir();
    try {
      const routeTool = failingCreateTaskTool();
      const toolExecutor = createToolExecutor([routeTool]);
      const provider = createProvider([{
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "failed-bind",
            tool: "git_context_create_task",
            input: {
              title: "Unavailable task",
              objective: "Exercise routing failure persistence.",
              createReason: "no_active_task",
            },
            dependsOn: [],
            purpose: "Bind the run before durable work",
          }],
          allowedTools: ["git_context_create_task"],
          assertions: [],
        },
      }]);
      const records: ContextRunStepRecord[] = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [routeTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-routing-failure"),
        recordRunStep(record) {
          records.push(record);
        },
        config: { maxConsecutiveFailures: 1 },
        clientId: "c1",
        initialUserMessage: "Create a durable task",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-routing-failure", "Create a durable task"),
      });

      expect(result).toMatchObject({
        runId: "R-routing-failure",
        outcome: "failed",
        stopReason: "failed",
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        runId: "R-routing-failure",
        step: 1,
        status: "failed",
        toolCalls: [{
          callId: "failed-bind",
          tool: "git_context_create_task",
          status: "failed",
        }],
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("finalizes as failed after routing retries are exhausted", async () => {
    const dataDir = makeTmpDir();
    try {
      const routeTool = failingCreateTaskTool();
      const toolExecutor = createToolExecutor([routeTool]);
      const routeDecision = (id: string) => ({
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id,
            tool: "git_context_create_task",
            input: {
              title: "Unavailable task",
              objective: "Exercise exhausted routing failures.",
              createReason: "no_active_task",
            },
            dependsOn: [],
            purpose: "Bind the run before durable work",
          }],
          allowedTools: ["git_context_create_task"],
          assertions: [],
        },
      });
      const provider = createProvider([
        routeDecision("failed-bind-1"),
        routeDecision("failed-bind-2"),
        { kind: "reply", status: "completed", message: "Task routing failed twice, so I could not complete the request." },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: [routeTool],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-routing-exhausted"),
        clientId: "c1",
        initialUserMessage: "Create a durable task",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-routing-exhausted", "Create a durable task"),
      });

      expect(result).toMatchObject({
        runId: "R-routing-exhausted",
        outcome: "failed",
        stopReason: "failed",
        status: "failed",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("maps a focused clarification to needs_user_input", async () => {
    const dataDir = makeTmpDir();
    try {
      const provider = createProvider([
        { kind: "reply", status: "completed", message: "Which file should I inspect? Please provide the file path." },
      ]);

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-clarify"),
        clientId: "c1",
        initialUserMessage: "Inspect it",
        dataDir,
        systemContext: "test system context",
        harnessContext: unboundContext("R-clarify", "Inspect it"),
      });

      expect(result).toMatchObject({
        runId: "R-clarify",
        outcome: "needs_user_input",
        stopReason: "needs_user_input",
        status: "completed",
        workState: {
          status: "needs_user_input",
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("maps context admission exhaustion to incomplete/context_limit without losing task state", async () => {
    const dataDir = makeTmpDir();
    const message = `Continue the task: ${"x".repeat(300_000)}`;
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: {
          nativeToolCalling: true,
          structuredOutput: { jsonObject: true, jsonSchema: true },
        },
        start: vi.fn(),
        stop: vi.fn(),
        countInputTokens: vi.fn().mockResolvedValue({
          provider: "mock",
          model: "1.0.0",
          inputTokens: 80_000,
          exact: true,
        }),
        generateTurn: vi.fn(),
      };

      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: runHandle("R-context-limit", 3),
        clientId: "c1",
        initialUserMessage: message,
        dataDir,
        systemContext: "test system context",
        harnessContext: boundContext("R-context-limit", message, dataDir),
      });

      expect(result).toMatchObject({
        runId: "R-context-limit",
        outcome: "incomplete",
        stopReason: "context_limit",
        status: "stuck",
        taskSummary: {
          runId: "R-context-limit",
          stopReason: "context_limit",
        },
      });
      expect(provider.generateTurn).not.toHaveBeenCalled();
    } finally {
      cleanup(dataDir);
    }
  });
});
