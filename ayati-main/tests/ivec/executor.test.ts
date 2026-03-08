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
import type { ToolExecutor } from "../../src/skills/tool-executor.js";
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
    taskStatus: "not_done" as const,
    approach: "use shell",
    latestSuccessfulStepSummary: "",
    latestStepNewFacts: [],
    recentStepDigests: [],
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
    recordAssistantFeedback: vi.fn(),
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
          return {
            type: "assistant",
            content: JSON.stringify({
              taskStatusAfter: "done",
              taskReason: "command output satisfied the goal",
              taskEvidence: ["command output: hello"],
            }),
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
      expect(summary.newFacts).toContain("tool_output:shell#1: hello");
      expect(existsSync(join(runPath, "steps", "001-act.md"))).toBe(true);
      expect(existsSync(join(runPath, "steps", "001-verify.md"))).toBe(true);
      expect(summary.artifacts).toContain("steps/001-act.md");
      expect(summary.artifacts).toContain("steps/001-verify.md");
      expect(summary.taskStatusAfter).toBe("done");
      expect(summary.taskEvidence).toEqual(["command output: hello"]);

      const verifyMarkdown = readFileSync(join(runPath, "steps", "001-verify.md"), "utf-8");
      expect(verifyMarkdown).toContain("- **Passed:** yes");
      expect(verifyMarkdown).toContain("- **Method:** gate");
      expect(verifyMarkdown).toContain("## Tool Calls");
      expect(verifyMarkdown).toContain("- 1. shell - pass");
      expect(verifyMarkdown).toContain("- **Tool Summary:** pass=1, fail=0");
      expect(verifyMarkdown).toContain("- **Task Status After:** done");
      expect(verifyMarkdown).toContain("command output satisfied the goal");
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
          return {
            type: "assistant",
            content: JSON.stringify({
              taskStatusAfter: "done",
              taskReason: "listed files",
              taskEvidence: ["file.txt"],
            }),
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
      expect(summary.newFacts).toContain("tool_error:shell#1: command failed");
      expect(summary.artifacts).toContain("steps/001-act.md");
      expect(summary.artifacts).toContain("steps/001-verify.md");

      const verifyMarkdown = readFileSync(join(runPath, "steps", "001-verify.md"), "utf-8");
      expect(verifyMarkdown).toContain("- **Passed:** no");
      expect(verifyMarkdown).toContain("- **Method:** gate");
      expect(verifyMarkdown).toContain("- 1. shell - fail (command failed)");
      expect(verifyMarkdown).toContain("- **Tool Summary:** pass=0, fail=1");
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

      const summary = await executeStep(deps, createDirective(), 1, runPath);
      expect(summary.outcome).toBe("failed");
      expect(summary.toolFailureCount).toBe(2);
      expect(summary.stoppedEarlyReason).toBe("repeated_identical_failure");
    } finally {
      cleanup();
    }
  });
});
