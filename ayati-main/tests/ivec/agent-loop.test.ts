import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { agentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import { noopRunRecorder } from "../../src/ivec/noop-run-recorder.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { SkillDefinition, ToolDefinition } from "../../src/skills/types.js";
import { ToolCatalog } from "../../src/ivec/agent-runner/tool-catalog.js";
import { ToolWorkingSetManager } from "../../src/ivec/agent-runner/tool-working-set.js";
import type { AgentFeedbackEventInput, AgentFeedbackLedger } from "../../src/ivec/feedback-ledger.js";

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
    name: "git_context_create_task_for_turn",
    description: "Create a task for the current turn.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "reason"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        reason: { type: "string" },
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

function fakeActivateTaskForTurnTool(): ToolDefinition {
  return {
    name: "git_context_activate_task_for_turn",
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

  it("repairs work tool actions when a fresh session has no active task", async () => {
    const dataDir = makeTmpDir();
    const outputPath = join(dataDir, "fresh-session.txt");
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
      expect(result.status).toBe("completed");
      expect(result.content).toBe("I need to create a task before using work tools.");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(existsSync(outputPath)).toBe(false);
      expect(secondUserPrompt).toContain("Use git_context_create_task_for_turn first");
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
              tool: "git_context_create_task_for_turn",
              input: {
                title: "Linux commands file",
                objective: "Create a text file with 10 important Linux commands.",
                reason: "The user asked for durable file creation work.",
              },
              dependsOn: [],
              purpose: "Create and activate the first task before using filesystem tools.",
            }],
            allowedTools: ["git_context_create_task_for_turn"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_file",
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

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [gitCreateTaskTool, writeFilesTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
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
      expect(result.totalToolCalls).toBe(2);
      expect(result.content).toBe(`I created the Linux commands file at ${outputPath}.`);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toContain("pwd - show current directory");
      expect(secondStateView.context.git.current.task.identity.workId).toBe("T-20260702-001");
      expect(secondDecisionTools).toContain("write_files");
      expect(secondDecisionTools).not.toContain("git_context_create_task_for_turn");
      expect(feedbackEvents(feedback.events, "tools", "tool_mode_selected").map((event) => event.data?.["mode"])).toContain("fresh_session_routing");
      expect(feedbackEvents(feedback.events, "tools", "pre_task_routing_tools_visible")[0]?.data).toMatchObject({
        mode: "fresh_session_routing",
        visibleRoutingTools: ["git_context_create_task_for_turn"],
      });
      expect(feedbackEvents(feedback.events, "tools", "normal_tools_enabled_for_work_run")[0]?.data).toMatchObject({
        workRunId: "R-20260702-001",
      });
      expect(feedbackEvents(feedback.events, "tools", "routing_tools_deactivated")[0]?.data).toMatchObject({
        workRunId: "R-20260702-001",
        completedRoutingTools: ["git_context_create_task_for_turn"],
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
        "git_context_ask_clarification_for_turn",
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
              tool: "git_context_activate_task_for_turn",
              input: {
                taskId: "T-20260702-website",
                reason: "The user is continuing the active website task.",
              },
              dependsOn: [],
              purpose: "Bind the pending turn to the existing active task before work tools run.",
            }],
            allowedTools: ["git_context_activate_task_for_turn"],
            assertions: [],
          },
        },
        {
          kind: "act",
          action: {
            mode: "single",
            calls: [{
              id: "write_file",
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

      const result = await agentLoop({
        provider,
        toolExecutor,
        toolWorkingSetManager,
        toolDefinitions: [gitActivateTaskTool, gitCreateTaskTool, ...gitReadOnlyTools, writeFilesTool],
        runRecorder: noopRunRecorder,
        feedbackLedger: feedback.ledger,
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
      expect(result.totalToolCalls).toBe(2);
      expect(result.content).toBe(`I updated the website task note at ${outputPath}.`);
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toContain("Website note");
      expect(firstDecisionTools).toEqual(expect.arrayContaining([
        "git_context_active",
        "git_context_list_tasks",
        "git_context_search_tasks",
        "git_context_read_task",
        "git_context_activate_task_for_turn",
        "git_context_create_task_for_turn",
        "git_context_ask_clarification_for_turn",
      ]));
      expect(secondStateView.context.git.current.task.identity.workId).toBe("T-20260702-website");
      expect(secondDecisionTools).toContain("write_files");
      expect(secondDecisionTools).not.toContain("git_context_activate_task_for_turn");
      expect(secondDecisionTools).not.toContain("git_context_create_task_for_turn");
      expect(feedbackEvents(feedback.events, "tools", "tool_mode_selected").map((event) => event.data?.["mode"])).toContain("pre_task_routing");
      expect(feedbackEvents(feedback.events, "tools", "pre_task_routing_tools_visible")[0]?.data).toMatchObject({
        mode: "pre_task_routing",
        pendingTurnStatus: "unbound",
      });
      expect(feedbackEvents(feedback.events, "tools", "normal_tools_enabled_for_work_run")[0]?.data).toMatchObject({
        workRunId: "R-20260702-website-002",
      });
      expect(feedbackEvents(feedback.events, "tools", "routing_tools_deactivated")[0]?.data).toMatchObject({
        workRunId: "R-20260702-website-002",
        completedRoutingTools: ["git_context_activate_task_for_turn"],
      });
    } finally {
      cleanup(dataDir);
    }
  });

  it("finalizes immediately when a verified action is marked as a completion candidate", async () => {
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
            completion: {
              intent: "completion_candidate",
              reason: `I created the requested website at ${outputPath}.`,
              expectedEvidence: ["index.html written"],
            },
          },
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
      expect(result.totalIterations).toBe(1);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(readFileSync(outputPath, "utf-8")).toBe("<!doctype html><title>Done</title>");
      expect(result.content).toBe(`I created the requested website at ${outputPath}.`);
      expect(result.taskSummary).toMatchObject({
        runStatus: "completed",
        taskStatus: "done",
        toolsUsed: ["write_files"],
      });
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
      expect(readFileSync(outputPath, "utf-8")).toBe("<!doctype html><title>Repaired</title>");
      const repairPrompt = (provider.generateTurn as any).mock.calls[1]?.[0].messages.at(-1).content as string;
      expect(repairPrompt).toContain("invalid tool input");
      expect(repairPrompt).toContain("missing required field 'files'");
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(3);
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
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(existsSync(indexPath)).toBe(true);
      expect(existsSync(cssPath)).toBe(true);
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

  it("feeds recent output context cards and evidence refs into the next decision", async () => {
    const dataDir = makeTmpDir();
    try {
      const ramSummaryTool: ToolDefinition = {
        name: "read_file",
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
                  tool: "read_file",
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
              allowedTools: ["read_file", "search_in_files"],
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
      expect(generateTurn).toHaveBeenCalledTimes(2);
      const secondCallInput = generateTurn.mock.calls[1]?.[0];
      const userPrompt = secondCallInput.messages.find((message: { role: string }) => message.role === "user").content as string;
      const stateView = extractStateView(userPrompt);
      expect(stateView.observations).toBeUndefined();
      expect(stateView.context.scratch.observations.latest).toHaveLength(2);
      expect(stateView.context.scratch.observations.latest[0].purpose).toBe("Get RAM summary");
      expect(stateView.context.scratch.observations.latest[0].content).toContain("3.5Gi used");
      expect(stateView.context.scratch.observations.latest[0].evidenceRef).toBe("evidence://ev_001_call_1");
      expect(stateView.context.scratch.observations.latest[1].purpose).toBe("List top RAM processes");
      expect(stateView.context.scratch.observations.latest[1].content).toContain("chromium");
      expect(stateView.context.scratch.observations.latest[1].evidenceRef).toBe("evidence://ev_001_call_2");
      expect(stateView.latestObservation).toBeUndefined();
      expect(userPrompt).not.toContain("\"latestObservation\"");
      expect(stateView.toolContext).toBeUndefined();
      expect(stateView.progress).toBeUndefined();
      expect(stateView.context.scratch.progress.evidenceRefs[0].ref).toBe("evidence://ev_001_call_1");
      expect(stateView.context.scratch.progress.evidenceRefs[1].ref).toBe("evidence://ev_001_call_2");
      expect(stateView.workingNotes).toBeUndefined();
      expect(userPrompt).toContain("evidence_search");
      expect(existsSync(join(dataDir, "runs", "r-observation", "raw", "001-call_1-read_file-output.txt"))).toBe(true);
      expect(existsSync(join(dataDir, "runs", "r-observation", "raw", "001-call_2-search_in_files-output.txt"))).toBe(true);
      const persisted = JSON.parse(readFileSync(join(dataDir, "runs", "r-observation", "state.json"), "utf-8"));
      expect(persisted.toolContext.recent).toHaveLength(2);
      expect(persisted.workingNotes).toBeUndefined();
    } finally {
      cleanup(dataDir);
    }
  });
});
