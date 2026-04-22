import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeStep } from "../../src/ivec/executor.js";
import { initRunDirectory } from "../../src/ivec/state-persistence.js";
import type { ExecutorDeps, StepDirective, LoopConfig } from "../../src/ivec/types.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";
import { createToolExecutor, type ToolExecutor } from "../../src/skills/tool-executor.js";
import { DEFAULT_LOOP_CONFIG } from "../../src/ivec/types.js";

function createTaskContext() {
  return {
    userMessage: "run a shell command",
    goal: {
      objective: "run a shell command",
      done_when: ["command output returned"],
      required_evidence: ["command output"],
      ask_user_when: [],
      stop_when_no_progress: [],
    },
    approach: "use shell",
    previousTaskProgress: {
      status: "not_done" as const,
      progressSummary: "",
      keyFacts: [],
      evidence: [],
    },
    latestSuccessfulStep: {
      summary: "",
      evidenceItems: [],
      taskFacts: [],
      artifacts: [],
    },
    recentSuccessfulSummaries: [],
  };
}

function createMockSessionMemory(): SessionMemory {
  return {
    initialize: vi.fn(),
    shutdown: vi.fn(),
    beginRun: vi.fn().mockReturnValue({ sessionId: "s1", runId: "r1" }),
    recordToolCall: vi.fn(),
    recordToolResult: vi.fn(),
    recordAssistantFinal: vi.fn(),
    recordRunFailure: vi.fn(),
    recordAgentStep: vi.fn(),
    getPromptMemoryContext: vi.fn().mockReturnValue({
      conversationTurns: [],
      previousSessionSummary: "",
    }),
    setStaticTokenBudget: vi.fn(),
  };
}

function createDirective(overrides?: Partial<StepDirective>): StepDirective {
  return {
    done: false,
    execution_mode: "dependent",
    intent: "run a shell command",
    tools_hint: ["shell"],
    success_criteria: "command output returned",
    context: "",
    ...overrides,
  };
}

function stepVerifyResponse(overrides?: {
  passed?: boolean;
  summary?: string;
  evidenceSummary?: string;
  evidenceItems?: string[];
  newFacts?: string[];
  artifacts?: string[];
}): string {
  return JSON.stringify({
    passed: overrides?.passed ?? true,
    summary: overrides?.summary ?? "Verified step output satisfied the success criteria.",
    evidenceSummary: overrides?.evidenceSummary ?? "Tool output matched the requested result.",
    evidenceItems: overrides?.evidenceItems ?? ["tool output reviewed"],
    newFacts: overrides?.newFacts ?? [],
    artifacts: overrides?.artifacts ?? [],
  });
}

function taskVerifyResponse(
  status = "done",
  progressSummary = "task completed",
  evidence: string[] = [],
  extra?: Partial<{
    keyFacts: string[];
    userInputNeeded: string;
  }>,
): string {
  return JSON.stringify({
    status,
    progressSummary,
    evidence,
    keyFacts: extra?.keyFacts ?? [],
    userInputNeeded: extra?.userInputNeeded,
  });
}

describe("executeStep", () => {
  let tmpDir: string;

  function setup(): { runPath: string; cleanup: () => void } {
    tmpDir = mkdtempSync(join(tmpdir(), "ayati-exec-"));
    const runPath = initRunDirectory(tmpDir, "test-run");
    return {
      runPath,
      cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  it("executes act → verify and writes step files", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            // act phase — tool call
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "shell", input: { cmd: "echo hello" } }],
            };
          }
          if (callCount === 2) {
            // act phase — after tool result, assistant text
            return { type: "assistant", content: "Command executed successfully" };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that the command returned hello.",
                evidenceSummary: "The shell output contained hello.",
                evidenceItems: ["shell output: hello"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "command output satisfied the goal", ["command output: hello"]),
          };
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const sessionMemory = createMockSessionMemory();
      const runHandle: MemoryRunHandle = { sessionId: "s1", runId: "r1" };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory,
        runHandle,
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective(), 1, runPath);

      expect(summary.step).toBe(1);
      expect(summary.outcome).toBe("success");
      expect(summary.toolSuccessCount).toBe(1);
      expect(summary.toolFailureCount).toBe(0);
      expect(Object.prototype.hasOwnProperty.call(summary, "evidence")).toBe(false);
      expect(summary.stoppedEarlyReason).toBe("assistant_returned");
      expect(summary.newFacts).toEqual([]);
      expect(existsSync(join(runPath, "steps", "001-act.md"))).toBe(true);
      expect(existsSync(join(runPath, "steps", "001-verify.md"))).toBe(true);
      expect(summary.artifacts).toContain("steps/001-act.md");
      expect(summary.artifacts).toContain("steps/001-verify.md");
      expect(summary.summary).toContain("Verified that the command returned hello.");
      expect(summary.taskProgress?.progressSummary).toBe("command output satisfied the goal");
      expect(summary.taskProgress?.status).toBe("done");
      expect(summary.taskProgress?.evidence).toEqual(["command output: hello", "shell output: hello"]);

      const verifyMarkdown = readFileSync(join(runPath, "steps", "001-verify.md"), "utf-8");
      expect(verifyMarkdown).toContain("- **Passed:** yes");
      expect(verifyMarkdown).toContain("- **Method:** llm");
      expect(verifyMarkdown).toContain("- **Execution Status:** all_succeeded");
      expect(verifyMarkdown).toContain("- **Validation Status:** passed");
      expect(verifyMarkdown).toContain("## Tool Calls");
      expect(verifyMarkdown).toContain("- 1. shell - pass");
      expect(verifyMarkdown).toContain("- **Tool Summary:** pass=1, fail=0");
      expect(verifyMarkdown).toContain("Verified that the command returned hello.");
      expect(verifyMarkdown).toContain("## Task Progress");
      expect(verifyMarkdown).toContain("- Status: done");
      expect(verifyMarkdown).toContain("- Progress Summary: command output satisfied the goal");
    } finally {
      cleanup();
    }
  });

  it("records tool calls to session memory", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { type: "tool_calls", calls: [{ id: "tc1", name: "shell", input: { cmd: "ls" } }] };
          }
          if (callCount === 2) {
            return { type: "assistant", content: "done" };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that the file list output was returned.",
                evidenceSummary: "The shell output listed file.txt.",
                evidenceItems: ["shell output: file.txt"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "listed files", ["file.txt"]),
          };
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "file.txt" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: "file.txt" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const sessionMemory = createMockSessionMemory();
      const runHandle: MemoryRunHandle = { sessionId: "s1", runId: "r1" };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory,
        runHandle,
        taskContext: createTaskContext(),
      };

      await executeStep(deps, createDirective(), 1, runPath);

      expect(sessionMemory.recordToolCall).toHaveBeenCalledTimes(1);
      expect(sessionMemory.recordToolResult).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("returns failed outcome when tool has error", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { type: "tool_calls", calls: [{ id: "tc1", name: "shell", input: { cmd: "bad" } }] };
          }
          return { type: "assistant", content: "failed" };
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: false, error: "command failed" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: false, error: "command failed" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const sessionMemory = createMockSessionMemory();
      const runHandle: MemoryRunHandle = { sessionId: "s1", runId: "r1" };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory,
        runHandle,
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective(), 1, runPath);
      expect(summary.outcome).toBe("failed");
      expect(summary.toolSuccessCount).toBe(0);
      expect(summary.toolFailureCount).toBe(1);
      expect(summary.newFacts).toEqual([]);
      expect(summary.artifacts).toContain("steps/001-act.md");
      expect(summary.artifacts).toContain("steps/001-verify.md");

      const verifyMarkdown = readFileSync(join(runPath, "steps", "001-verify.md"), "utf-8");
      expect(verifyMarkdown).toContain("- **Passed:** no");
      expect(verifyMarkdown).toContain("- **Method:** execution_gate");
      expect(verifyMarkdown).toContain("- **Execution Status:** all_failed");
      expect(verifyMarkdown).toContain("- **Validation Status:** skipped");
      expect(verifyMarkdown).toContain("- 1. shell - fail (command failed)");
      expect(verifyMarkdown).toContain("- **Tool Summary:** pass=0, fail=1");
    } finally {
      cleanup();
    }
  });

  it("treats thrown tool exceptions as failed tool results instead of aborting the step", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return { type: "tool_calls", calls: [{ id: "tc1", name: "shell_run_script", input: { scriptPath: "/tmp/fetch_wttr.sh" } }] };
          }
          return { type: "assistant", content: "failed" };
        }),
      };

      const toolExecutor = createToolExecutor([
        {
          name: "shell_run_script",
          description: "Run script",
          inputSchema: { type: "object", properties: { scriptPath: { type: "string" } }, required: ["scriptPath"] },
          async execute() {
            throw new Error("ENOENT: no such file or directory, stat '/tmp/fetch_wttr.sh'");
          },
        },
      ]);

      const sessionMemory = createMockSessionMemory();
      const runHandle: MemoryRunHandle = { sessionId: "s1", runId: "r1" };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory,
        runHandle,
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({ tools_hint: ["shell_run_script"] }), 1, runPath);
      expect(summary.outcome).toBe("failed");
      expect(summary.toolSuccessCount).toBe(0);
      expect(summary.toolFailureCount).toBe(1);
      expect(summary.newFacts).toEqual([]);
      expect(existsSync(join(runPath, "steps", "001-act.md"))).toBe(true);
      expect(existsSync(join(runPath, "steps", "001-verify.md"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("keeps non-hinted built-in tools available during act", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "read_file", input: { path: "package.json" } }],
            };
          }
          if (callCount === 2) {
            return { type: "assistant", content: "Read the file successfully" };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that package.json content was retrieved.",
                evidenceSummary: "The read_file output contained package.json content.",
                evidenceItems: ["read_file output reviewed"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "file content retrieved", ["package.json content"]),
          };
        }),
      };

      const shellExecute = vi.fn().mockResolvedValue({ ok: true, output: "shell-ok" });
      const readFileExecute = vi.fn().mockResolvedValue({ ok: true, output: "{\"name\":\"ayati\"}" });
      const toolExecutor: ToolExecutor = {
        list: () => ["shell", "read_file"],
        definitions: () => [
          {
            name: "shell",
            description: "Run shell",
            inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
            execute: shellExecute,
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            execute: readFileExecute,
          },
        ],
        execute: vi.fn().mockImplementation(async (toolName: string, input: unknown) => {
          if (toolName === "shell") return shellExecute(input);
          return readFileExecute(input);
        }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({ execution_mode: "independent", tools_hint: ["shell"] }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(summary.toolSuccessCount).toBe(1);
      expect(shellExecute).not.toHaveBeenCalled();
      expect(readFileExecute).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("blocks repeated failed retries and pivots to another available tool", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "shell", input: { cmd: "bad" } }],
            };
          }
          if (callCount === 2) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc2", name: "shell", input: { cmd: "bad" } }],
            };
          }
          if (callCount === 3) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc3", name: "read_file", input: { path: "package.json" } }],
            };
          }
          if (callCount === 4) {
            return { type: "assistant", content: "Recovered by reading the file" };
          }
          if (callCount === 5) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that the fallback read_file call recovered the step.",
                evidenceSummary: "The successful read_file output satisfied the step despite earlier shell failures.",
                evidenceItems: ["read_file output reviewed", "shell retry failure observed"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "recovered with alternate tool", ["package.json content"]),
          };
        }),
      };

      const shellExecute = vi.fn().mockResolvedValue({ ok: false, error: "command failed" });
      const readFileExecute = vi.fn().mockResolvedValue({ ok: true, output: "{\"name\":\"ayati\"}" });
      const toolExecutor: ToolExecutor = {
        list: () => ["shell", "read_file"],
        definitions: () => [
          {
            name: "shell",
            description: "Run shell",
            inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
            execute: shellExecute,
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            execute: readFileExecute,
          },
        ],
        execute: vi.fn().mockImplementation(async (toolName: string, input: unknown) => {
          if (toolName === "shell") return shellExecute(input);
          return readFileExecute(input);
        }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({ execution_mode: "independent", tools_hint: ["shell"] }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(summary.toolSuccessCount).toBe(1);
      expect(summary.toolFailureCount).toBe(2);
      expect(shellExecute).toHaveBeenCalledTimes(1);
      expect(readFileExecute).toHaveBeenCalledTimes(1);
      expect(summary.newFacts).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("enforces one tool call per turn in dependent mode", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [
                { id: "tc1", name: "shell", input: { cmd: "echo one" } },
                { id: "tc2", name: "shell", input: { cmd: "echo two" } },
              ],
            };
          }
          return { type: "assistant", content: "done" };
        }),
      };

      const executeSpy = vi.fn().mockResolvedValue({ ok: true, output: "ok" });
      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: executeSpy,
        }],
        execute: executeSpy,
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({ execution_mode: "dependent" }), 1, runPath);
      expect(summary.toolSuccessCount).toBe(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("rejects multi-call planned directives in dependent mode", async () => {
    const { runPath, cleanup } = setup();
    try {
      const executeSpy = vi.fn().mockResolvedValue({ ok: true, output: "ok" });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "assistant",
          content: JSON.stringify({ status: "not_done", progressSummary: "should not be called", evidence: [] }),
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: executeSpy,
        }],
        execute: executeSpy,
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({
        execution_mode: "dependent",
        tool_plan: [
          { tool: "shell", input: { cmd: "echo one" }, origin: "builtin", source_refs: [], retry_policy: "none" },
          { tool: "shell", input: { cmd: "echo two" }, origin: "builtin", source_refs: [], retry_policy: "none" },
        ],
      }), 1, runPath);

      expect(summary.outcome).toBe("failed");
      expect(summary.stoppedEarlyReason).toBe("planned_call_failed");
      expect(summary.toolSuccessCount).toBe(0);
      expect(summary.toolFailureCount).toBe(0);
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("allows broker-mounted external tools without source refs", async () => {
    const { runPath, cleanup } = setup();
    try {
      const executeSpy = vi.fn().mockResolvedValue({ ok: true, output: "external ok" });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn()
          .mockResolvedValueOnce({
            type: "assistant",
            content: stepVerifyResponse({
              summary: "Verified the broker-mounted external tool output.",
              evidenceSummary: "The external tool returned the expected response.",
              evidenceItems: ["external tool output: external ok"],
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: taskVerifyResponse("done", "external tool completed", ["external tool output: external ok"]),
          }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["demo-search.query"],
        definitions: () => [{
          name: "demo-search.query",
          description: "Run external query",
          inputSchema: { type: "object", properties: {} },
          execute: executeSpy,
        }],
        execute: executeSpy,
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({
        tool_plan: [
          { tool: "demo-search.query", input: {}, origin: "external_tool", source_refs: [], retry_policy: "none" },
        ],
      }), 1, runPath);

      expect(summary.outcome).toBe("success");
      expect(summary.toolSuccessCount).toBe(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("surfaces external tool execution failures directly", async () => {
    const { runPath, cleanup } = setup();
    try {
      const executeSpy = vi.fn().mockResolvedValue({ ok: false, error: "External tool is runtime-inactive", output: "" });
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn()
          .mockResolvedValueOnce({
            type: "assistant",
            content: stepVerifyResponse({
              passed: false,
              summary: "The external tool failed before completing the step.",
              evidenceSummary: "The external tool reported a runtime-inactive failure.",
              evidenceItems: ["external tool runtime-inactive"],
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: taskVerifyResponse("not_done", "external tool blocked", ["external tool runtime-inactive"]),
          }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["demo-search.query"],
        definitions: () => [{
          name: "demo-search.query",
          description: "External tool placeholder",
          inputSchema: { type: "object", properties: {} },
          execute: executeSpy,
        }],
        execute: executeSpy,
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({
        tool_plan: [
          { tool: "demo-search.query", input: {}, origin: "external_tool", source_refs: [], retry_policy: "none" },
        ],
      }), 1, runPath);

      expect(summary.outcome).toBe("failed");
      expect(summary.stoppedEarlyReason).toBe("planned_call_failed");
      expect(summary.toolFailureCount).toBe(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("spills large tool output to a raw artifact file", async () => {
    const { runPath, cleanup } = setup();
    try {
      const largeOutput = "A".repeat(DEFAULT_LOOP_CONFIG.maxInlineActOutputChars + 500);
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn()
          .mockResolvedValueOnce({
            type: "assistant",
            content: stepVerifyResponse({
              summary: "Verified the large shell output from the raw artifact.",
              evidenceSummary: "Verification reopened the persisted raw artifact for validation.",
              evidenceItems: ["raw artifact content reviewed"],
              artifacts: ["steps/001-call-01-raw.txt"],
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: taskVerifyResponse("done", "large output captured", ["raw artifact persisted"]),
          }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: largeOutput }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: largeOutput }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({
        tool_plan: [
          { tool: "shell", input: { cmd: "echo huge" }, origin: "builtin", source_refs: [], retry_policy: "none" },
        ],
      }), 1, runPath);

      const rawOutputRelativePath = "steps/001-call-01-raw.txt";
      const rawOutputFile = join(runPath, rawOutputRelativePath);
      const actMarkdown = readFileSync(join(runPath, "steps", "001-act.md"), "utf-8");

      expect(summary.outcome).toBe("success");
      expect(summary.artifacts).toContain(rawOutputRelativePath);
      expect(summary.newFacts).toEqual([]);
      expect(existsSync(rawOutputFile)).toBe(true);
      expect(readFileSync(rawOutputFile, "utf-8")).toBe(largeOutput);
      expect(actMarkdown).toContain("**Output Storage:** raw_file");
      expect(actMarkdown).toContain(`**Raw Output File:** ${rawOutputRelativePath}`);
      expect(actMarkdown).not.toContain(largeOutput);
      expect(summary.usedRawArtifacts).toContain(rawOutputRelativePath);
    } finally {
      cleanup();
    }
  });

  it("stops when max total tool calls per step is reached", async () => {
    const { runPath, cleanup } = setup();
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "tool_calls",
          calls: [
            { id: "tc1", name: "shell", input: { cmd: "echo one" } },
            { id: "tc2", name: "shell", input: { cmd: "echo two" } },
          ],
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: { ...DEFAULT_LOOP_CONFIG, maxTotalToolCallsPerStep: 6 },
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective({ execution_mode: "independent" }), 1, runPath);
      expect(summary.toolSuccessCount).toBe(6);
      expect(summary.stoppedEarlyReason).toBe("max_total_tool_calls_reached");
      expect(summary.summary).not.toBe("");
    } finally {
      cleanup();
    }
  });

  it("forces a final assistant-only wrap-up when tool execution ends without assistant text", async () => {
    const { runPath, cleanup } = setup();
    try {
      const turnInputs: LlmTurnInput[] = [];
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          turnInputs.push(input);
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "shell", input: { cmd: "echo hello" } }],
            };
          }
          if (callCount === 2) {
            return {
              type: "assistant",
              content: "Executed the shell command and captured the output hello before the step hit its tool-turn limit.",
            };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that the captured shell output hello satisfies the step.",
                evidenceSummary: "The assistant wrap-up and shell output both confirmed hello was captured.",
                evidenceItems: ["shell output: hello"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "command output satisfied the goal", ["command output: hello"]),
          };
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: { ...DEFAULT_LOOP_CONFIG, maxToolCallsPerStep: 1 },
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({ execution_mode: "independent" }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(summary.stoppedEarlyReason).toBe("max_act_turns_reached");
      expect(summary.summary).toContain("captured shell output hello");
      expect(turnInputs[1]?.tools).toBeUndefined();

      const actMarkdown = readFileSync(join(runPath, "steps", "001-act.md"), "utf-8");
      expect(actMarkdown).toContain("## Final Text");
      expect(actMarkdown).toContain("captured the output hello");
    } finally {
      cleanup();
    }
  });

  it("stops early on repeated identical failures", async () => {
    const { runPath, cleanup } = setup();
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockResolvedValue({
          type: "tool_calls",
          calls: [{ id: "tc1", name: "shell", input: { cmd: "bad" } }],
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: false, error: "command failed" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: false, error: "command failed" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({ execution_mode: "independent" }),
        1,
        runPath,
      );
      expect(summary.outcome).toBe("failed");
      expect(summary.toolFailureCount).toBe(3);
      expect(summary.stoppedEarlyReason).toBe("repeated_identical_failure");
      expect(summary.summary).not.toBe("");
    } finally {
      cleanup();
    }
  });

  it("does not add an extra wrap-up turn when act already returned assistant text", async () => {
    const { runPath, cleanup } = setup();
    try {
      let callCount = 0;
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              type: "tool_calls",
              calls: [{ id: "tc1", name: "shell", input: { cmd: "echo hello" } }],
            };
          }
          if (callCount === 2) {
            return { type: "assistant", content: "Command executed successfully" };
          }
          if (callCount === 3) {
            return {
              type: "assistant",
              content: stepVerifyResponse({
                summary: "Verified that the command executed successfully and returned hello.",
                evidenceSummary: "The shell output contained hello.",
                evidenceItems: ["shell output: hello"],
              }),
            };
          }
          return {
            type: "assistant",
            content: taskVerifyResponse("done", "command output satisfied the goal", ["command output: hello"]),
          };
        }),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell"],
        definitions: () => [{
          name: "shell",
          description: "Run shell",
          inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
          execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        }],
        execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: DEFAULT_LOOP_CONFIG,
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective(), 1, runPath);

      expect(summary.summary).toBe("Verified that the command executed successfully and returned hello.");
      expect(provider.generateTurn).toHaveBeenCalledTimes(4);
    } finally {
      cleanup();
    }
  });
});
