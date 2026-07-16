import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput, LlmTurnStreamCallbacks } from "../../src/core/contracts/llm-protocol.js";
import { noopRunRecorder } from "../../src/ivec/noop-run-recorder.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";

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

function createProvider(responses: unknown[]): LlmProvider {
  const queue = addExplicitCompletionToLegacyFixtures(responses)
    .map((response) => typeof response === "string" ? response : JSON.stringify(response));
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

function addExplicitCompletionToLegacyFixtures(responses: unknown[]): unknown[] {
  const output: unknown[] = [];
  let pendingMutation = false;
  for (const response of responses) {
    const record = response && typeof response === "object" ? response as Record<string, unknown> : undefined;
    if (record?.["kind"] === "act") {
      const action = record["action"] as { calls?: Array<{ tool?: string }> } | undefined;
      pendingMutation ||= (action?.calls ?? []).some((call) => [
        "write_files",
        "patch_files",
        "create_directory",
        "move",
        "delete",
        "shell",
        "python_execute",
      ].includes(call.tool ?? ""));
    }
    if (record?.["kind"] === "reply" && pendingMutation) {
      const message = typeof record["message"] === "string" ? record["message"] : "";
      const asksForInput = /\b(?:send|provide|i need|which|what should)\b/i.test(message);
      if (!asksForInput) {
        output.push({
          kind: "task_completion",
          request: {
            summary: message || "Completed the requested task.",
            assets: [],
          },
        });
        pendingMutation = false;
      }
    }
    output.push(response);
    if (record?.["kind"] === "task_completion") pendingMutation = false;
  }
  return output;
}

function createMemoryFeedbackLedger(): { ledger: AgentFeedbackLedger; events: AgentFeedbackEventInput[] } {
  const events: AgentFeedbackEventInput[] = [];
  return {
    events,
    ledger: {
      enabled: true,
      record(event) {
        events.push(event);
      },
      async flush() {
        return;
      },
      async close() {
        return;
      },
    },
  };
}

function feedbackEvents(
  events: AgentFeedbackEventInput[],
  stage: string,
  event: string,
): AgentFeedbackEventInput[] {
  return events.filter((entry) => entry.stage === stage && entry.event === event);
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

function fakeCreateTaskForTurnTool(): ToolDefinition {
  return {
    name: "git_context_create_task",
    description: "Create a task for the current turn.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "createReason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        createReason: {
          type: "string",
          enum: [
            "no_active_task",
            "explicit_user_requested_new_task",
            "new_unrelated_goal",
          ],
        },
        reasonDetails: { type: "string" },
      },
    },
    async execute() {
      const structuredContent = {
        status: "ready",
        mode: "create_new_task",
        sessionId: "s1",
        taskId: "T-20260702-001",
        branch: "task/T-20260702-001-linux-commands",
        runId: "R-20260702-001",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 0,
            },
            focus: {
              status: "active",
              ref: "refs/heads/task/T-20260702-001-linux-commands",
              workId: "T-20260702-001",
            },
            task: {
              ref: "refs/heads/task/T-20260702-001-linux-commands",
              workId: "T-20260702-001",
              title: "Linux commands file",
              objective: "Create a text file with important Linux commands.",
              status: "active",
              completed: [],
              open: ["Create a text file with important Linux commands."],
              blockers: [],
              facts: [],
              next: "Create the commands file.",
              assets: [],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
      };
      return {
        ok: true,
        output: "Created task T-20260702-001 and run R-20260702-001.",
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "GIT_CONTEXT_TURN_TASK_CREATED",
          message: "Pending turn created a new git-context task.",
          structuredContent,
        },
      };
    },
  };
}

function fakeFailingCreateTaskForTurnTool(onExecute?: () => void): ToolDefinition {
  return {
    name: "git_context_create_task",
    description: "Create a task for the current turn.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "createReason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        createReason: {
          type: "string",
          enum: [
            "no_active_task",
            "explicit_user_requested_new_task",
            "new_unrelated_goal",
          ],
        },
      },
    },
    async execute() {
      onExecute?.();
      return {
        ok: false,
        output: "",
        error: "simulated create failure",
        v2: {
          transportOk: true,
          operationStatus: "failed",
          code: "SIMULATED_CREATE_FAILURE",
          message: "Simulated create failure.",
          structuredContent: {
            status: "failed",
          },
        },
      };
    },
  };
}

function fakeActivateTaskForTurnTool(): ToolDefinition {
  return {
    name: "git_context_activate_task",
    description: "Activate an existing task for the current turn.",
    inputSchema: {
      type: "object",
      required: ["taskId", "reason"],
      properties: {
        taskId: { type: "string" },
        reason: { type: "string" },
      },
    },
    async execute() {
      const structuredContent = {
        status: "ready",
        mode: "continue_active_task",
        sessionId: "s1",
        taskId: "T-20260702-website",
        branch: "task/T-20260702-website",
        runId: "R-20260702-website-002",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 1,
            },
            focus: {
              status: "active",
              ref: "refs/heads/task/T-20260702-website",
              workId: "T-20260702-website",
            },
            task: {
              ref: "refs/heads/task/T-20260702-website",
              workId: "T-20260702-website",
              title: "Website task",
              objective: "Maintain the website task.",
              status: "active",
              completed: ["Created initial website files."],
              open: ["Add a commands note file."],
              blockers: [],
              facts: [],
              next: "Add a commands note file.",
              assets: [],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
      };
      return {
        ok: true,
        output: "Activated task T-20260702-website and run R-20260702-website-002.",
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "GIT_CONTEXT_TURN_TASK_ACTIVATED",
          message: "Pending turn activated on existing git-context task.",
          structuredContent,
        },
      };
    },
  };
}

function fakeGitContextReadTool(name: string, output: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture tool.`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true, output };
    },
  };
}

function fakeVerificationFailureTool(): ToolDefinition {
  return {
    name: "fake_verify_failure",
    description: "A test tool that succeeds but reports a failed required assertion.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    async execute(input) {
      const path = typeof input["path"] === "string" ? input["path"] : "missing.txt";
      return {
        ok: true,
        output: `Wrote ${path}`,
        v2: {
          transportOk: true,
          operationStatus: "succeeded",
          code: "FAKE_VERIFY_FAILURE",
          message: "Tool execution succeeded but verification failed.",
          verification: {
            assertions: [{
              id: "expected-file",
              kind: "file_exists",
              status: "failed",
              severity: "required",
              message: `Expected file was not found: ${path}`,
            }],
          },
        },
      };
    },
  };
}

function extractStateView(userPrompt: string): any {
  const marker = "State view:\n";
  const start = userPrompt.indexOf(marker);
  if (start < 0) {
    throw new Error("State view section missing from decision prompt.");
  }
  const raw = userPrompt.slice(start + marker.length).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const objectStart = raw.indexOf("{");
    if (objectStart < 0) {
      throw new Error("State view JSON object missing from decision prompt.");
    }
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = objectStart; index < raw.length; index++) {
      const char = raw[index];
      if (!char) continue;
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
      if (inString) {
        continue;
      }
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return JSON.parse(raw.slice(objectStart, index + 1));
        }
      }
    }
    throw new Error("State view JSON object was incomplete.");
  }
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
        runRecorder: noopRunRecorder,
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
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r2" },
        clientId: "c1",
        initialUserMessage: `Please handle ${outputPath}`,
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("task");
      expect(result.totalIterations).toBe(3);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toBe("created by harness");
      expect(result.content).toContain(outputPath);
      expect(result.content).not.toContain("Done -");
      expect(result.content).not.toContain("deterministic verification");
      expect(result.content).not.toContain("Evidence:");
    } finally {
      cleanup(dataDir);
    }
  });

  it("executes read-only tools in a session run without creating a task run", async () => {
    const dataDir = makeTmpDir();
    try {
      const readTool: ToolDefinition = {
        name: "read_files",
        description: "Read a file without mutating the workspace.",
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
        async execute() {
          return {
            ok: true,
            output: "upload handling lives in src/upload.ts",
          };
        },
      };
      const toolExecutor = createToolExecutor([readTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "read_files",
              input: { path: "src/upload.ts" },
              dependsOn: [],
              purpose: "Inspect upload handling",
            }],
            allowedTools: ["read_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Upload handling lives in src/upload.ts.",
        },
      ]);
      const createWorkRun = vi.fn();
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 1 });
      const recordTaskStep = vi.fn();
      const recordSessionStep = vi.fn(async () => ({
        contextEngine: {
          session: {
            meta: { sessionId: "s1", assetCount: 0 },
            conversationTail: [],
            activityTail: [],
          },
          focus: { status: "none" as const },
          readContext: {
            revision: "read-revision-1",
            entries: [{
              key: "read_files:src/upload.ts",
              runId: "R-session",
              step: 1,
              runClass: "session" as const,
              tool: "read_files",
              purpose: "Inspect upload handling",
              resources: ["src/upload.ts"],
              input: { path: "src/upload.ts" },
              output: "upload handling lives in src/upload.ts",
              verification: { passed: true },
              createdAt: "2026-07-14T10:00:00.000Z",
            }],
          },
        },
      }));

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        inputHandle: { sessionId: "s1", seq: 1 },
        createSessionRun,
        createWorkRun,
        recordTaskStep,
        recordSessionStep,
        clientId: "c1",
        initialUserMessage: "where is upload handling implemented?",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("session");
      expect(result.workRunId).toBeUndefined();
      expect(result.workState).toMatchObject({
        status: "done",
        summary: "Upload handling lives in src/upload.ts.",
        openWork: [],
        blockers: [],
        evidence: expect.arrayContaining([
          expect.stringContaining("read_files"),
        ]),
      });
      expect(result.workState?.nextStep).toBeUndefined();
      expect(result.workState?.userInputNeeded).toBeUndefined();
      const secondCallInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const secondPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const secondStateView = extractStateView(secondPrompt);
      expect(secondStateView.context.run).toMatchObject({
        status: "not_done",
        workState: expect.objectContaining({
          status: "not_done",
          evidence: expect.arrayContaining([
            expect.stringContaining("read_files"),
          ]),
        }),
        toolCalls: [expect.objectContaining({
          tool: "read_files",
          status: "success",
          mode: "reference",
          readContextKeys: ["read_files:src/upload.ts"],
        })],
      });
      expect(secondStateView.context.run.toolCalls[0]).not.toHaveProperty("output");
      expect(secondStateView.context.git.current.readContext).toMatchObject({
        entries: [expect.objectContaining({
          key: "read_files:src/upload.ts",
          output: "upload handling lives in src/upload.ts",
        })],
      });
      expect(secondStateView.context.run.routing).toBeUndefined();
      expect(createSessionRun).toHaveBeenCalledWith({ sessionId: "s1", seq: 1 });
      expect(createWorkRun).not.toHaveBeenCalled();
      expect(recordTaskStep).not.toHaveBeenCalled();
      expect(recordSessionStep).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "s1",
        runId: "R-session",
        status: "completed",
        summary: expect.stringContaining("read_files"),
        workStateAfter: expect.objectContaining({
          evidence: expect.arrayContaining([
            expect.stringContaining("read_files"),
          ]),
        }),
        toolCalls: [expect.objectContaining({
          tool: "read_files",
          status: "success",
        })],
      }));
    } finally {
      cleanup(dataDir);
    }
  });

  it("uses task_completion before a response-only final task reply", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "tea.html");
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
                files: [{ path: outputPath, content: "<h1>Tea Stall</h1>\n" }],
              },
              dependsOn: [],
              purpose: "Create the requested page",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: {
            summary: "Created the requested tea stall HTML page.",
            assets: [{
              path: outputPath,
              kind: "file",
              description: "Main tea stall HTML page",
            }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Created `tea.html` with a simple tea stall page.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-work-state-final" },
        clientId: "c1",
        initialUserMessage: "Create a small tea stall HTML page.",
        dataDir,
        systemContext: "full system context with memory",
      });

      const finalCallInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const finalPrompt = finalCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("task");
      expect(result.workState?.status).toBe("done");
      expect(result.workState?.summary).toBe("Created the requested tea stall HTML page.");
      expect(result.workState).not.toHaveProperty("taskNotes");
      expect(result.taskAssets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: outputPath,
          description: "Main tea stall HTML page",
        }),
      ]));
      expect(result.verifiedCompletionAssets).toEqual([expect.objectContaining({
        path: outputPath,
        kind: "file",
        description: "Main tea stall HTML page",
      })]);
      expect(result.content).toBe("Created `tea.html` with a simple tea stall page.");
      expect(result.content).not.toContain("deterministic verification");
      expect(readFileSync(outputPath, "utf-8")).toContain("Tea Stall");
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(finalCallInput.tools).toEqual([]);
      expect(finalPrompt).toContain("\"status\": \"done\"");
      expect(finalPrompt).toContain("Created the requested tea stall HTML page.");
    } finally {
      cleanup(dataDir);
    }
  });

  it("continues task work after task_completion rejects a missing asset", async () => {
    const dataDir = makeTmpDir();
    const indexPath = join(dataDir, "site", "index.html");
    const cssPath = join(dataDir, "site", "styles.css");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{ id: "write_index", tool: "write_files", input: { createDirs: true, files: [{ path: indexPath, content: "<h1>Site</h1>" }] }, dependsOn: [], purpose: "Create the homepage" }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: {
            summary: "Created the requested website files.",
            assets: [{ path: cssPath, kind: "file", description: "Website styling" }],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{ id: "write_css", tool: "write_files", input: { files: [{ path: cssPath, content: "body { color: black; }" }] }, dependsOn: [], purpose: "Create the missing stylesheet" }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: {
            summary: "Created the requested homepage and stylesheet.",
            assets: [
              { path: indexPath, kind: "file", description: "Main website page" },
              { path: cssPath, kind: "file", description: "Website styling" },
            ],
          },
        },
        { kind: "reply", status: "completed", message: "Created the homepage and stylesheet." },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-completion-retry" },
        clientId: "c1",
        initialUserMessage: "Create a homepage and stylesheet",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.workState?.status).toBe("done");
      expect(readFileSync(cssPath, "utf-8")).toContain("color: black");
      expect(provider.generateTurn).toHaveBeenCalledTimes(5);
    } finally {
      cleanup(dataDir);
    }
  });

  it("reserves completion and final-response decisions after the task work limit", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "limited.html");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_limited",
              tool: "write_files",
              input: { files: [{ path: outputPath, content: "<h1>Complete</h1>" }] },
              dependsOn: [],
              purpose: "Create the requested limited-step page.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: {
            summary: "Created the limited-step page.",
            assets: [{ path: outputPath, kind: "file", description: "Requested limited-step HTML page" }],
          },
        },
        { kind: "reply", status: "completed", message: "Created and verified the requested page." },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-run-limit-complete" },
        clientId: "c1",
        initialUserMessage: "Create the limited page",
        dataDir,
        systemContext: "full system context with memory",
        config: { maxIterations: 1 },
      });

      expect(result.status).toBe("completed");
      expect(result.workState?.status).toBe("done");
      expect(result.totalIterations).toBe(3);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(vi.mocked(provider.generateTurn).mock.calls[1]?.[0]?.tools.map((tool) => tool.name)).toEqual(["task_completion"]);
      expect(vi.mocked(provider.generateTurn).mock.calls[2]?.[0]?.tools).toEqual([]);
    } finally {
      cleanup(dataDir);
    }
  });

  it("reports verified partial progress when run-limit completion is rejected", async () => {
    const dataDir = makeTmpDir();
    const createdPath = join(dataDir, "index.html");
    const missingPath = join(dataDir, "styles.css");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_partial",
              tool: "write_files",
              input: { files: [{ path: createdPath, content: "<h1>Partial</h1>" }] },
              dependsOn: [],
              purpose: "Create the homepage before adding its stylesheet.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: {
            summary: "Created the requested website.",
            assets: [{ path: missingPath, kind: "file", description: "Required website stylesheet" }],
          },
        },
        { kind: "reply", status: "completed", message: "I created the homepage, but the stylesheet still needs to be created." },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-run-limit-partial" },
        clientId: "c1",
        initialUserMessage: "Create a homepage and stylesheet",
        dataDir,
        systemContext: "full system context with memory",
        config: { maxIterations: 1 },
      });

      expect(result.status).toBe("stuck");
      expect(result.workState?.status).toBe("not_done");
      expect(result.taskSummary?.stopReason).toBe("run_limit");
      expect(result.workState?.openWork).toEqual(expect.arrayContaining([
        expect.stringContaining("styles.css"),
      ]));
      expect(result.content).toContain("stylesheet still needs to be created");
      expect(result.totalIterations).toBe(3);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
    } finally {
      cleanup(dataDir);
    }
  });

  it("keeps a task waiting for user input when a direct reply finishes only the turn", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "project-note", "notes.md");
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
                files: [{ path: outputPath, content: "# Project Notes\n\nPlaceholder.\n" }],
              },
              dependsOn: [],
              purpose: "Create the placeholder note file first.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "I created the placeholder note file. Send the final points and I will add them.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-partial-waiting" },
        clientId: "c1",
        initialUserMessage: "Create a project note file, but start with a placeholder first.",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("I created the placeholder note file. Send the final points and I will add them.");
      expect(readFileSync(outputPath, "utf-8")).toContain("Placeholder");
      expect(result.workState?.status).toBe("needs_user_input");
      expect(result.workState?.userInputNeeded).toBe("Send the final points and I will add them.");
      expect(result.taskSummary).toMatchObject({
        runStatus: "completed",
        taskStatus: "needs_user_input",
        stopReason: "needs_user_input",
        userInputNeeded: "Send the final points and I will add them.",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("repairs work tool actions when a fresh session has no active task", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "fresh-session.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 1 });
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                files: [{ path: outputPath, content: "should not run before task creation" }],
              },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "I need to create a task before using work tools.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createSessionRun,
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a small text file",
        dataDir,
        systemContext: "full system context with memory",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 0,
            },
            focus: {
              status: "none",
            },
          },
        },
      });

      const secondCallInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const secondUserPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const secondDecisionTools = secondCallInput.tools.map((tool: { name: string }) => tool.name);
      const secondStateView = extractStateView(secondUserPrompt);
      expect(result.status).toBe("completed");
      expect(result.content).toBe("I need to create a task before using work tools.");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(existsSync(outputPath)).toBe(false);
      expect(secondDecisionTools).not.toContain("write_files");
      expect(secondDecisionTools).toContain("decision_load_tools");
      expect(secondStateView.context.runtimeMode).toMatchObject({
        name: "fresh_session_routing",
        repairCode: "R_FRESH_SESSION_NEEDS_TASK",
      });
      expect(secondUserPrompt).toContain("Create a task only when the current user request has a concrete deliverable");
      expect(secondUserPrompt).toContain("R_FRESH_SESSION_NEEDS_TASK");
      expect(feedbackEvents(feedback.events, "action", "started")).toHaveLength(0);
    } finally {
      cleanup(dataDir);
    }
  });

  it("repairs normal tool attempts before the first task is routed", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "missing-run.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 1 });
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                files: [{ path: outputPath, content: "should not run without a work run" }],
              },
              dependsOn: [],
              purpose: "Create a file.",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "blocked",
          message: "I need to create a task before writing files.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createSessionRun,
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a file",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(existsSync(outputPath)).toBe(false);
      expect(feedbackEvents(feedback.events, "action", "started")).toHaveLength(0);
      expect(feedbackEvents(feedback.events, "decision", "repair_requested")[0]?.data).toMatchObject({
        repair: {
          code: "R_TOOL_NOT_SELECTED",
          blockedTargets: ["write_files"],
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("blocks create task after two failed routing attempts in one turn", async () => {
    const dataDir = makeTmpDir();
    try {
      let createExecutions = 0;
      const gitCreateTaskTool = fakeFailingCreateTaskForTurnTool(() => {
        createExecutions += 1;
      });
      const toolExecutor = createToolExecutor([gitCreateTaskTool]);
      const feedback = createMemoryFeedbackLedger();
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([
          skill("git-context", [gitCreateTaskTool]),
        ]),
        toolExecutor,
        maxVisibleTools: 12,
      });
      const createDecision = {
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "create_task",
            tool: "git_context_create_task",
            input: {
              title: "Create notes",
              objective: "Create a notes file.",
              createReason: "no_active_task",
            },
            dependsOn: [],
            purpose: "Create a task before durable work.",
          }],
          allowedTools: ["git_context_create_task"],
          assertions: [],
        },
      };
      const provider = createProvider([
        createDecision,
        createDecision,
        createDecision,
        {
          kind: "reply",
          status: "blocked",
          message: "I need clarification before I can route this task.",
        },
      ]);
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 1 });

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [gitCreateTaskTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createSessionRun,
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a notes file",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.workRunId).toBeUndefined();
      expect(createExecutions).toBe(2);
      const thirdCallInput = vi.mocked(provider.generateTurn).mock.calls[2]?.[0];
      const thirdPrompt = thirdCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const thirdStateView = extractStateView(thirdPrompt);
      expect(thirdStateView.context.run.routing).toMatchObject({
        failureCount: 2,
        maxFailures: 2,
        resolved: false,
        lastTool: "git_context_create_task",
        lastError: "simulated create failure",
      });
      expect((thirdCallInput.tools ?? []).map((tool: { function?: { name?: string }; name?: string }) => tool.function?.name ?? tool.name))
        .not.toContain("git_context_create_task");
      expect(feedbackEvents(feedback.events, "guard", "routing_retry_limit_reached").length).toBeGreaterThan(0);
      expect(feedbackEvents(feedback.events, "decision", "repair_requested").at(-1)?.data).toMatchObject({
        repair: {
          blockedTargets: ["git_context_create_task"],
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("continues with normal tools after creating the first task in a fresh session", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "linux-commands.txt");
    try {
      const gitCreateTaskTool = fakeCreateTaskForTurnTool();
      const toolExecutor = createToolExecutor([]);
      const feedback = createMemoryFeedbackLedger();
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([
          skill("git-context", [gitCreateTaskTool]),
          skill("filesystem", [writeFilesTool]),
        ]),
        toolExecutor,
        maxVisibleTools: 12,
      });
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "create_task",
              tool: "git_context_create_task",
              input: {
                title: "Linux commands file",
                objective: "Create a text file with 10 important Linux commands.",
                createReason: "no_active_task",
                reasonDetails: "The user asked for durable file creation work.",
              },
              dependsOn: [],
              purpose: "Create and activate the first task before using filesystem tools.",
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
              id: "write_files",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{
                  path: outputPath,
                  content: [
                    "1. pwd - show current directory",
                    "2. ls - list files",
                    "3. cd - change directory",
                  ].join("\n"),
                }],
              },
              dependsOn: [],
              purpose: "Write the requested commands file after task creation.",
            }],
            allowedTools: ["write_files"],
            assertions: [{ kind: "file_exists", path: "$.files[0].path" }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `I created the Linux commands file at ${outputPath}.`,
        },
      ]);
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 1 });

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [gitCreateTaskTool, writeFilesTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createSessionRun,
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a txt file with 10 Linux commands",
        dataDir,
        systemContext: "full system context with memory",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 0,
            },
            focus: {
              status: "none",
            },
          },
        },
      });

      const secondCallInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const secondUserPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const secondDecisionTools = secondCallInput.tools.map((tool: { name: string }) => tool.name);
      const secondStateView = extractStateView(secondUserPrompt);
      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("task");
      expect(result.workRunId).toBe("R-20260702-001");
      expect(result.totalToolCalls).toBe(1);
      expect(result.content).toBe(`I created the Linux commands file at ${outputPath}.`);
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(readFileSync(outputPath, "utf-8")).toContain("pwd - show current directory");
      expect(secondStateView.context.git.current.task.identity.workId).toBe("T-20260702-001");
      expect(secondDecisionTools).toContain("write_files");
      expect(secondDecisionTools).not.toContain("git_context_create_task");
      expect(feedbackEvents(feedback.events, "tools", "tool_mode_selected").map((event) => event.data?.["mode"])).toContain("fresh_session_routing");
      expect(feedbackEvents(feedback.events, "tools", "routing_window_visible")[0]?.data).toMatchObject({
        mode: "fresh_session_routing",
        step: 1,
        maxSteps: 0,
        remaining: 0,
        open: true,
        expiresAfterThisDecision: false,
        routingToolsAvailable: true,
        readToolsRemainAfterExpiry: true,
      });
      expect(feedbackEvents(feedback.events, "tools", "pre_task_routing_tools_visible")[0]?.data).toMatchObject({
        mode: "fresh_session_routing",
        visibleRoutingTools: expect.arrayContaining(["git_context_create_task"]),
        routingWindow: {
          open: true,
          step: 1,
          maxSteps: 0,
        },
      });
      expect(feedbackEvents(feedback.events, "tools", "normal_tools_enabled_for_work_run")[0]?.data).toMatchObject({
        workRunId: "R-20260702-001",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("continues with normal tools after activating an existing task for an unbound turn", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "website-notes.txt");
    try {
      const gitActivateTaskTool = fakeActivateTaskForTurnTool();
      const gitCreateTaskTool = fakeCreateTaskForTurnTool();
      const gitReadOnlyTools = [
        "git_context_active",
        "git_context_list_tasks",
        "git_context_search_tasks",
        "git_context_read_task",
      ].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return { ok: true, output: `${name} ok` };
        },
      } satisfies ToolDefinition));
      const toolExecutor = createToolExecutor([]);
      const feedback = createMemoryFeedbackLedger();
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([
          skill("git-context", [
            ...gitReadOnlyTools,
            gitCreateTaskTool,
            gitActivateTaskTool,
          ]),
          skill("filesystem", [writeFilesTool]),
        ]),
        toolExecutor,
        maxVisibleTools: 12,
      });
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "activate_task",
              tool: "git_context_activate_task",
              input: {
                taskId: "T-20260702-website",
                reason: "continue_active_task",
              },
              dependsOn: [],
              purpose: "Bind the pending turn to the existing active task before work tools run.",
            }],
            allowedTools: ["git_context_activate_task"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_files",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{
                  path: outputPath,
                  content: "Website note: remember to keep commands visible.",
                }],
              },
              dependsOn: [],
              purpose: "Write the requested note file after task activation.",
            }],
            allowedTools: ["write_files"],
            assertions: [{ kind: "file_exists", path: "$.files[0].path" }],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `I updated the website task note at ${outputPath}.`,
        },
      ]);
      const createSessionRun = vi.fn().mockResolvedValue({ sessionId: "s1", runId: "R-session", triggerSeq: 6 });

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [gitActivateTaskTool, gitCreateTaskTool, ...gitReadOnlyTools, writeFilesTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createSessionRun,
        inputHandle: { sessionId: "s1", seq: 6 },
        clientId: "c1",
        initialUserMessage: "Add a note file for this website task",
        dataDir,
        systemContext: "full system context with memory",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 1,
            },
            focus: {
              status: "active",
              ref: "refs/heads/task/T-20260702-website",
              workId: "T-20260702-website",
            },
            pendingTurn: {
              routingStatus: "unbound",
              fromSeq: 6,
              toSeq: 6,
              text: "Add a note file for this website task",
            },
            task: {
              ref: "refs/heads/task/T-20260702-website",
              workId: "T-20260702-website",
              title: "Website task",
              objective: "Maintain the website task.",
              status: "active",
              completed: ["Created initial website files."],
              open: ["Add a note file."],
              blockers: [],
              facts: [],
              next: "Add a note file.",
              assets: [],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
      });

      const firstCallInput = vi.mocked(provider.generateTurn).mock.calls[0]?.[0];
      const secondCallInput = vi.mocked(provider.generateTurn).mock.calls[1]?.[0];
      const firstDecisionTools = firstCallInput.tools.map((tool: { name: string }) => tool.name);
      const secondDecisionTools = secondCallInput.tools.map((tool: { name: string }) => tool.name);
      const secondUserPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const secondStateView = extractStateView(secondUserPrompt);
      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("task");
      expect(result.workRunId).toBe("R-20260702-website-002");
      expect(result.totalToolCalls).toBe(1);
      expect(result.content).toBe(`I updated the website task note at ${outputPath}.`);
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(readFileSync(outputPath, "utf-8")).toContain("Website note");
      expect(firstDecisionTools).toEqual(expect.arrayContaining([
        "git_context_activate_task",
        "git_context_create_task",
      ]));
      expect(secondStateView.context.git.current.task.identity.workId).toBe("T-20260702-website");
      expect(secondDecisionTools).toContain("write_files");
      expect(secondDecisionTools).not.toContain("git_context_activate_task");
      expect(secondDecisionTools).not.toContain("git_context_create_task");
      expect(feedbackEvents(feedback.events, "tools", "tool_mode_selected").map((event) => event.data?.["mode"])).toContain("pre_task_routing");
      expect(feedbackEvents(feedback.events, "tools", "pre_task_routing_tools_visible")[0]?.data).toMatchObject({
        mode: "pre_task_routing",
        pendingTurnStatus: "unbound",
      });
      expect(feedbackEvents(feedback.events, "tools", "normal_tools_enabled_for_work_run")[0]?.data).toMatchObject({
        workRunId: "R-20260702-website-002",
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("repairs unavailable legacy task discovery without creating a run", async () => {
    const dataDir = makeTmpDir();
    try {
      const listTasksTool = fakeGitContextReadTool("git_context_list_tasks", "No tasks found.");
      const gitCreateTaskTool = fakeCreateTaskForTurnTool();
      const createWorkRun = vi.fn();
      const toolExecutor = createToolExecutor([]);
      const feedback = createMemoryFeedbackLedger();
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([
          skill("git-context", [
            fakeGitContextReadTool("git_context_active", "No active task."),
            listTasksTool,
            gitCreateTaskTool,
          ]),
        ]),
        toolExecutor,
        maxVisibleTools: 12,
      });
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "list_tasks",
              tool: "git_context_list_tasks",
              input: {},
              dependsOn: [],
              purpose: "Check whether any task exists before answering.",
            }],
            allowedTools: ["git_context_list_tasks"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "There are no tasks yet.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [listTasksTool, gitCreateTaskTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        createWorkRun,
        inputHandle: { sessionId: "s1", seq: 10 },
        clientId: "c1",
        initialUserMessage: "Do I have any tasks yet?",
        dataDir,
        systemContext: "full system context with memory",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              conversationTail: [],
              activityTail: [],
              assetCount: 0,
            },
            focus: {
              status: "none",
            },
          },
        },
      });

      expect(result.status).toBe("completed");
      expect(result.runClass).toBe("interaction");
      expect(result.workRunId).toBeUndefined();
      expect(result.totalToolCalls).toBe(0);
      expect(createWorkRun).not.toHaveBeenCalled();
      expect(feedbackEvents(feedback.events, "guard", "missing_work_run")).toHaveLength(0);
      expect(feedbackEvents(feedback.events, "action", "started")).toHaveLength(0);
      expect(feedbackEvents(feedback.events, "tools", "routing_window_visible")).toHaveLength(0);
      expect(feedbackEvents(feedback.events, "tools", "routing_window_suppressed")[0]?.data).toMatchObject({
        mode: "fresh_session_routing",
        step: 1,
        maxSteps: 0,
        remaining: 0,
        open: false,
        expiresAfterThisDecision: false,
        readToolsVisible: [],
        routingToolsVisible: [],
        routingToolsAvailable: false,
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("finalizes with a user-facing reply after explicit task completion", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "completion-site", "index.html");
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
                files: [{ path: outputPath, content: "<!doctype html><title>Done</title>" }],
              },
              dependsOn: [],
              purpose: "Create the requested website",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "Created `completion-site/index.html` for the small website.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-completion-candidate" },
        clientId: "c1",
        initialUserMessage: "Create a small website",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(3);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toBe("<!doctype html><title>Done</title>");
      expect(result.content).toBe("Created `completion-site/index.html` for the small website.");
      expect(result.content).not.toContain("Batch write");
      expect(result.content).not.toContain("sha256");
      expect(result.content).not.toContain("deterministic verification");
      expect(result.taskSummary).toMatchObject({
        runStatus: "completed",
        taskStatus: "done",
        toolsUsed: ["write_files"],
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("rejects control-token prose from the response-only final turn", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "completion-site", "index.html");
    const feedback = createMemoryFeedbackLedger();
    const completionSummary = "Verified website implementation detail. ".repeat(23)
      + "END-OF-COMPLETION";
    expect(completionSummary.length).toBeGreaterThan(900);
    expect(completionSummary.length).toBeLessThan(1_000);
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
                files: [{ path: outputPath, content: "<!doctype html><title>Done</title>" }],
              },
              dependsOn: [],
              purpose: "Create the requested website",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "task_completion",
          request: { summary: completionSummary, assets: [] },
        },
        "task_completion",
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-final-control-token" },
        clientId: "c1",
        initialUserMessage: "Create a small website",
        dataDir,
        systemContext: "full system context with memory",
        feedbackLedger: feedback.ledger,
      });

      expect(result.status).toBe("completed");
      expect(result.totalIterations).toBe(3);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toBe("<!doctype html><title>Done</title>");
      expect(result.content).not.toBe("task_completion");
      expect(result.content).toBe(completionSummary);
      expect(feedbackEvents(feedback.events, "decision", "final_response_rejected")).toHaveLength(1);
    } finally {
      cleanup(dataDir);
    }
  });

  it("publishes absolute generated file and parent directory assets for multi-file outputs", async () => {
    const dataDir = makeTmpDir();
    const outputDir = join(dataDir, "generated-project");
    const indexPath = join(outputDir, "index.html");
    const stylePath = join(outputDir, "styles.css");
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
                  { path: indexPath, content: "<!doctype html><title>Generated</title>" },
                  { path: stylePath, content: "body { margin: 0; }" },
                ],
              },
              dependsOn: [],
              purpose: "Create generated project files",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: "I created the generated project files.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-generated-assets" },
        clientId: "c1",
        initialUserMessage: "Create a small generated project",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.taskSummary).toMatchObject({
        runStatus: "completed",
        taskStatus: "done",
        toolsUsed: ["write_files"],
      });
      const assets = result.taskAssets ?? [];
      expect(assets).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "directory",
          role: "generated",
          name: "generated-project",
          path: outputDir,
        }),
        expect.objectContaining({
          kind: "file",
          role: "generated",
          name: "index.html",
          path: indexPath,
        }),
      ]));
      expect(assets.every((asset) => !asset.path || isAbsolute(asset.path))).toBe(true);
    } finally {
      cleanup(dataDir);
    }
  });

  it("repairs invalid selected tool input before executing an action", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "repaired-site", "index.html");
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
              input: {},
              dependsOn: [],
              purpose: "Create the requested website",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{ path: outputPath, content: "<!doctype html><title>Repaired</title>" }],
              },
              dependsOn: [],
              purpose: "Create the requested website",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `I created the requested website at ${outputPath}.`,
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-repair-input" },
        clientId: "c1",
        initialUserMessage: "Create a small website",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("completed");
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      expect(readFileSync(outputPath, "utf-8")).toBe("<!doctype html><title>Repaired</title>");
      const repairPrompt = (provider.generateTurn as any).mock.calls[1]?.[0].messages.at(-1).content as string;
      expect(repairPrompt).toContain("Repair code: R_TOOL_INPUT_MISSING_REQUIRED_FIELD");
      expect(repairPrompt).toContain("Missing fields: files");
    } finally {
      cleanup(dataDir);
    }
  });

  it("surfaces verification failures as repair-coded feedback", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "verify-failure.txt");
    try {
      const verifyFailureTool = fakeVerificationFailureTool();
      const toolExecutor = createToolExecutor([verifyFailureTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "fake_verify_failure",
              input: {
                path: outputPath,
              },
              dependsOn: [],
              purpose: "Attempt a tool action with tool-owned verification.",
            }],
            allowedTools: ["fake_verify_failure"],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "failed",
          message: "I could not verify the requested file.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        runHandle: { sessionId: "s1", runId: "r-verify-repair" },
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a file and verify it",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("failed");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      const repairPrompt = (provider.generateTurn as any).mock.calls[1]?.[0].messages.at(-1).content as string;
      expect(repairPrompt).toContain("R_VERIFICATION_FAILED");
      expect(feedbackEvents(feedback.events, "verification", "completed")[0]?.data).toMatchObject({
        repair: {
          code: "R_VERIFICATION_FAILED",
          blockedTargets: ["fake_verify_failure"],
          operatorDetails: {
            failureType: "verify_failed",
          },
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("surfaces no-progress failures as repair-coded feedback", async () => {
    const dataDir = makeTmpDir();
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [],
            allowedTools: [],
            assertions: [],
          },
        },
        {
          kind: "reply",
          status: "failed",
          message: "I did not have a concrete tool action to run.",
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        runHandle: { sessionId: "s1", runId: "r-no-progress" },
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Do the work",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("failed");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      const repairPrompt = (provider.generateTurn as any).mock.calls[1]?.[0].messages.at(-1).content as string;
      expect(repairPrompt).toContain("R_NO_PROGRESS");
      expect(feedbackEvents(feedback.events, "decision", "repair_requested")[0]?.data).toMatchObject({
        reason: "tool_protocol_violation",
        repair: {
          code: "R_NO_PROGRESS",
          operatorDetails: {
            reason: "act decision contained no tool calls",
          },
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("loads tools through a load_tools decision before executing them", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "loaded-tool.txt");
    try {
      const toolExecutor = createToolExecutor([]);
      const toolWorkingSetManager = new ToolWorkingSetManager({
        catalog: new ToolCatalog([{
          id: "filesystem",
          version: "1.0.0",
          description: "Filesystem tools",
          promptBlock: "",
          tools: [writeFilesTool],
        }]),
        toolExecutor,
        maxVisibleTools: 12,
      });
      const provider = createProvider([
        {
          kind: "load_tools",
          request: {
            toolNames: ["write_files"],
            reason: "Need to create the requested file",
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                files: [{ path: outputPath, content: "loaded tool wrote this" }],
              },
              dependsOn: [],
              purpose: "Create the requested file",
            }],
            allowedTools: ["write_files"],
          },
        },
        {
          kind: "reply",
          status: "completed",
          message: `I created ${outputPath}.`,
        },
      ]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-load-tools" },
        clientId: "c1",
        initialUserMessage: `Please handle ${outputPath}`,
        dataDir,
        systemContext: "static decision context",
      });

      expect(result.status).toBe("completed");
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
      const firstPrompt = (provider.generateTurn as any).mock.calls[0]?.[0].messages.find((message: { role: string }) => message.role === "user").content as string;
      const secondPrompt = (provider.generateTurn as any).mock.calls[1]?.[0].messages.find((message: { role: string }) => message.role === "user").content as string;
      expect(firstPrompt).toContain("Selected tools:\n(none)");
      expect(secondPrompt).toContain("write_files");
      expect(readFileSync(outputPath, "utf-8")).toBe("loaded tool wrote this");
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
        runRecorder: noopRunRecorder,
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(existsSync(indexPath)).toBe(true);
      expect(existsSync(cssPath)).toBe(true);
    } finally {
      cleanup(dataDir);
    }
  });

  it("streams only the response-only final reply after verified tool work", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "final-stream", "note.txt");
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const finalDeltas: string[] = [];
      const generateTurn = vi.fn()
        .mockResolvedValueOnce({
          type: "assistant",
          content: JSON.stringify({
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "call_1",
              tool: "write_files",
              input: {
                createDirs: true,
                files: [{
                  path: outputPath,
                  content: "streamed final response test",
                }],
              },
              dependsOn: [],
              purpose: "Write the note",
            }],
            allowedTools: ["write_files"],
            assertions: [],
          },
          }),
        })
        .mockResolvedValueOnce({
          type: "assistant",
          content: JSON.stringify({
            kind: "task_completion",
            request: { summary: "Created the requested note file.", assets: [] },
          }),
        });
      const streamTurn = vi.fn(async (
        _input: LlmTurnInput,
        callbacks: LlmTurnStreamCallbacks,
      ): Promise<LlmTurnOutput> => {
        callbacks.onTextDelta?.("Done. ");
        callbacks.onTextDelta?.("I wrote the note.");
        return {
          type: "assistant",
          content: "Done. I wrote the note.",
        };
      });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: {
          nativeToolCalling: true,
          streaming: true,
          structuredOutput: { jsonObject: true },
        },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn,
        streamTurn,
      };
      const streamEvents: Array<{ type: string; delta?: string; kind?: string }> = [];

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-final-stream" },
        clientId: "c1",
        initialUserMessage: "write a note",
        dataDir,
        systemContext: "full system context with memory",
        onFinalResponseStream: (event) => {
          streamEvents.push(event);
          if (event.type === "delta") {
            finalDeltas.push(event.delta);
          }
        },
      });

      expect(result.status).toBe("completed");
      expect(result.content).toBe("Done. I wrote the note.");
      expect(generateTurn).toHaveBeenCalledTimes(2);
      expect(streamTurn).toHaveBeenCalledTimes(1);
      expect(streamEvents[0]).toEqual({ type: "start", kind: "reply" });
      expect(finalDeltas.join("")).toBe("Done. I wrote the note.");
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      cleanup(dataDir);
    }
  });

  it("feeds git context through the structured context pack without old session continuity", async () => {
    const dataDir = makeTmpDir();
    try {
      const generateTurn = vi.fn().mockResolvedValue({
        type: "assistant",
        content: JSON.stringify({ kind: "reply", status: "completed", message: "context received" }),
      });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true } },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn,
      };
      await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        inputHandle: { sessionId: "s1", seq: 3 },
        runHandle: { sessionId: "s1", runId: "r-context", triggerSeq: 3 },
        clientId: "c1",
        initialUserMessage: "make it responsive too",
        dataDir,
        systemContext: "static decision context",
        harnessContext: {
          personalMemorySnapshot: "- Prefers concise implementation notes.",
          contextEngine: {
            session: {
              sessionId: "2026-06-12",
              activityTail: [],
              assetCount: 1,
              conversationTail: [
                {
                  seq: 1,
                  role: "user",
                  at: "2026-06-12T09:00:00.000Z",
                  text: "Build a todo app",
                },
                {
                  seq: 2,
                  role: "assistant",
                  at: "2026-06-12T09:01:00.000Z",
                  text: "Created the todo app.",
                },
                {
                  seq: 3,
                  role: "user",
                  at: "2026-06-12T09:10:00.000Z",
                  text: "make it responsive too",
                },
              ],
            },
            focus: {
              status: "active",
              ref: "refs/heads/work/W-20260612-0001-todo-app",
              workId: "W-20260612-0001",
            },
            task: {
              ref: "refs/heads/work/W-20260612-0001-todo-app",
              workId: "W-20260612-0001",
              title: "Todo app",
              objective: "Build a todo app",
              status: "active",
              completed: ["Created the todo app."],
              open: ["make responsive"],
              blockers: [],
              facts: [{ text: "todo/index.html exists", source: "fixture" }],
              next: "make responsive",
              assets: [{
                assetId: "A-20260612-0001",
                role: "output",
                kind: "file",
                name: "index.html",
                path: "todo/index.html",
              }],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
      });

      const callInput = generateTurn.mock.calls[0]?.[0];
      const systemPrompt = callInput.messages.find((message: { role: string }) => message.role === "system").content as string;
      const userPrompt = callInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateView = extractStateView(userPrompt);
      expect(systemPrompt).toContain("Decision rules:");
      expect(systemPrompt).toContain("Control tool shapes:");
      expect(systemPrompt).toContain("call the selected executable tool directly");
      expect(systemPrompt).toContain("Evidence-before-done rule:");
      expect(userPrompt).not.toContain("Decision rules:");
      expect(userPrompt.indexOf("Selected tools:\n")).toBeLessThan(userPrompt.indexOf("State view:\n"));
      expect(stateView.userMessage).toBeUndefined();
      expect(stateView.goal).toBeUndefined();
      expect(stateView.workState).toBeUndefined();
      expect(stateView.progress).toBeUndefined();
      expect(stateView.toolContext).toBeUndefined();
      expect(stateView.lastActions).toBeUndefined();
      expect(stateView.trace).toBeUndefined();
      expect(stateView.attachments).toBeUndefined();
      expect(stateView.runPath).toBeUndefined();
      expect(stateView.context.runtime).toBeUndefined();
      expect(stateView.context.session).toBeUndefined();
      expect(stateView.context.recentSystemActivity).toBeUndefined();
      expect(stateView.context.continuity).toBeUndefined();
      expect(stateView.context.sessionWork).toBeUndefined();
      expect(stateView.context.taskThreadContext).toBeUndefined();
      expect(stateView.context.gitContext).toBeUndefined();
      expect(stateView.context.git.current.task).toMatchObject({
        identity: {
          workId: "W-20260612-0001",
        },
        state: {
          open: ["make responsive"],
          next: "make responsive",
        },
      });
      expect(stateView.context.timeline).toHaveLength(3);
      expect(stateView.context.timeline[0]).toMatchObject({ seq: 1, kind: "user", content: "Build a todo app" });
      expect(stateView.context.timeline[2]).toMatchObject({ seq: 3, kind: "user", content: "make it responsive too", current: true });
      expect(stateView.context.recentActivity).toBeUndefined();
      expect(stateView.context.recentExact).toBeUndefined();
      expect(stateView.context.recentTasks).toBeUndefined();
      expect(stateView.context.previousSessionSummary).toBeUndefined();
      expect(stateView.context.personalMemorySnapshot).toBeUndefined();
      expect(stateView.context.personal.memorySnapshot).toContain("concise");
    } finally {
      cleanup(dataDir);
    }
  });

  it("feeds prior tool calls and outputs into the next decision", async () => {
    const dataDir = makeTmpDir();
    try {
      const ramSummaryTool: ToolDefinition = {
        name: "read_files",
        description: "Read RAM summary fixture",
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
        async execute() {
          return {
            ok: true,
            output: "Mem: 7.4Gi total, 3.5Gi used, 3.8Gi available",
          };
        },
      };
      const processSummaryTool: ToolDefinition = {
        name: "search_in_files",
        description: "Search process summary fixture",
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
        async execute() {
          return {
            ok: true,
            output: "PID USER %MEM RSS COMMAND\n100 sai 5.3 416820 chromium\n200 sai 5.2 407288 code\n300 sai 3.0 239548 node",
          };
        },
      };
      const toolExecutor = createToolExecutor([ramSummaryTool, processSummaryTool]);
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
                  tool: "read_files",
                  input: { path: "/proc/meminfo" },
                  dependsOn: [],
                  purpose: "Get RAM summary",
                },
                {
                  id: "call_2",
                  tool: "search_in_files",
                  input: { path: "/proc", query: "memory" },
                  dependsOn: [],
                  purpose: "List top RAM processes",
                },
              ],
              allowedTools: ["read_files", "search_in_files"],
            },
          }),
        })
        .mockResolvedValueOnce({
          type: "assistant",
          content: JSON.stringify({
            kind: "task_completion",
            request: { summary: "Analyzed current RAM use and the top memory-consuming programs.", assets: [] },
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
        capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true } },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn,
      };

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        runHandle: { sessionId: "s1", runId: "r-observation" },
        clientId: "c1",
        initialUserMessage: "what is my ram usage and what programs are using it?",
        dataDir,
        systemContext: "static decision context",
      });

      expect(result.status).toBe("completed");
      expect(generateTurn).toHaveBeenCalledTimes(3);
      const secondCallInput = generateTurn.mock.calls[1]?.[0];
      const userPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateView = extractStateView(userPrompt);
      expect(stateView.observations).toBeUndefined();
      expect(stateView.context.run.observations).toBeUndefined();
      expect(stateView.context.run.readContext).toBeUndefined();
      expect(stateView.context.run.toolCalls).toHaveLength(2);
      expect(stateView.context.run.toolCalls[0].tool).toBe("read_files");
      expect(stateView.context.run.toolCalls[0].purpose).toBe("Get RAM summary");
      expect(stateView.context.run.toolCalls[0].input).toEqual({ path: "/proc/meminfo" });
      expect(stateView.context.run.toolCalls[0].output).toContain("3.5Gi used");
      expect(stateView.context.run.toolCalls[0].stepRef).toEqual({ runId: "r-observation", step: 1, callId: "call_1" });
      expect(stateView.context.run.toolCalls[0]).not.toHaveProperty("evidenceRef");
      expect(stateView.context.run.toolCalls[0]).not.toHaveProperty("hasMore");
      expect(stateView.context.run.toolCalls[1].tool).toBe("search_in_files");
      expect(stateView.context.run.toolCalls[1].purpose).toBe("List top RAM processes");
      expect(stateView.context.run.toolCalls[1].input).toEqual({ path: "/proc", query: "memory" });
      expect(stateView.context.run.toolCalls[1].output).toContain("chromium");
      expect(stateView.context.run.toolCalls[1].stepRef).toEqual({ runId: "r-observation", step: 1, callId: "call_2" });
      expect(stateView.context.run.toolCalls[1]).not.toHaveProperty("evidenceRef");
      expect(stateView.context.run.toolCalls[1]).not.toHaveProperty("hasMore");
      expect(JSON.stringify(stateView.context.run.workState)).not.toContain("Get RAM summary");
      expect(JSON.stringify(stateView.context.run.workState)).not.toContain("List top RAM processes");
      expect(stateView.latestObservation).toBeUndefined();
      expect(userPrompt).not.toContain("\"latestObservation\"");
      expect(stateView.toolContext).toBeUndefined();
      expect(stateView.progress).toBeUndefined();
      expect(stateView.context.run.progress).toBeUndefined();
      expect(stateView.workingNotes).toBeUndefined();
      expect(existsSync(join(dataDir, "runs", "r-observation"))).toBe(false);
    } finally {
      cleanup(dataDir);
    }
  });

  it("stops when the same repair signature repeats too many times", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "repeat-repair.txt");
    const badAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: {
            createDirs: true,
            files: [{ path: outputPath, content: "should not be written" }],
          },
          dependsOn: [],
          purpose: "Create the requested file",
        }],
        allowedTools: [],
        assertions: [],
      },
    };
    try {
      const toolExecutor = createToolExecutor([writeFilesTool]);
      const feedback = createMemoryFeedbackLedger();
      const provider = createProvider([badAction, badAction, badAction]);

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        runHandle: { sessionId: "s1", runId: "r-repeat-repair" },
        inputHandle: { sessionId: "s1", seq: 1 },
        clientId: "c1",
        initialUserMessage: "Create a file",
        dataDir,
        systemContext: "full system context with memory",
      });

      expect(result.status).toBe("failed");
      expect(result.content).toContain("The same repair class repeated too many times.");
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(existsSync(outputPath)).toBe(false);
      expect(feedbackEvents(feedback.events, "guard", "repeated_repair_failure")[0]?.data).toMatchObject({
        repair: {
          code: "R_REPEATED_REPAIR_FAILURE",
          blockedTargets: ["write_files"],
          operatorDetails: {
            repeatedThreshold: 3,
            previousRepairCode: "R_TOOL_NOT_SELECTED",
          },
        },
      });
      expect(feedbackEvents(feedback.events, "final", "reply")[0]?.data).toMatchObject({
        feedbackSummary: {
          status: "failed",
        },
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("ends only the current task run when context recovery is exhausted", async () => {
    const dataDir = makeTmpDir();
    const feedback = createMemoryFeedbackLedger();
    const currentRequest = `Continue the task: ${"x".repeat(300_000)}`;
    const countInputTokens = vi.fn().mockResolvedValue({
      provider: "mock",
      model: "1.0.0",
      inputTokens: 80_000,
      exact: true,
    });
    const generateTurn = vi.fn();
    const provider: LlmProvider = {
      name: "mock",
      version: "1.0.0",
      capabilities: { nativeToolCalling: true, structuredOutput: { jsonObject: true, jsonSchema: true } },
      start: vi.fn(),
      stop: vi.fn(),
      countInputTokens,
      generateTurn,
    };
    try {
      const result = await agentLoop({
        provider,
        toolDefinitions: [],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
        inputHandle: { sessionId: "s1", seq: 3 },
        runHandle: { sessionId: "s1", runId: "r-context-limit", triggerSeq: 3 },
        clientId: "c1",
        initialUserMessage: currentRequest,
        dataDir,
        systemContext: "full system context with memory",
        harnessContext: {
          contextEngine: {
            session: {
              sessionId: "s1",
              activityTail: [],
              assetCount: 0,
              conversationTail: [{
                seq: 3,
                role: "user",
                at: "2026-07-10T10:00:00.000Z",
                text: currentRequest,
              }],
            },
            focus: {
              status: "active",
              ref: "refs/heads/work/W-1-context",
              workId: "W-1",
            },
            task: {
              ref: "refs/heads/work/W-1-context",
              workId: "W-1",
              title: "Context-sensitive task",
              objective: "Continue without losing durable task state.",
              status: "active",
              completed: ["Finished the first stage."],
              open: ["Complete the second stage."],
              blockers: [],
              facts: [{ text: "The first stage is verified.", source: "fixture" }],
              next: "Complete the second stage.",
              assets: [],
              recentRuns: [],
              recentCommits: [],
              recentEvidence: [],
            },
          },
        },
      });

      expect(result).toMatchObject({
        status: "stuck",
        runClass: "task",
        content: "This run reached its context capacity. I preserved the completed work and task state so it can continue in a new turn.",
        workState: {
          status: "not_done",
          openWork: ["Complete the second stage."],
          verifiedFacts: ["The first stage is verified."],
          nextStep: "Complete the second stage.",
        },
        taskSummary: {
          runStatus: "stuck",
          taskStatus: "open",
          stopReason: "context_limit",
          completedMilestones: ["Finished the first stage."],
          openWork: ["Complete the second stage."],
          nextAction: "Complete the second stage.",
        },
      });
      expect(countInputTokens).toHaveBeenCalledTimes(1);
      expect(generateTurn).not.toHaveBeenCalled();
      expect(feedbackEvents(feedback.events, "guard", "context_limit")).toHaveLength(1);
    } finally {
      cleanup(dataDir);
    }
  });
});
