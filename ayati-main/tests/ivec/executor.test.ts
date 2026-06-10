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

function planCall(
  tool: string,
  input: Record<string, unknown> = {},
  overrides?: Partial<{
    id: string;
    origin: "builtin" | "external_tool";
    source_refs: string[];
    retry_policy: "none" | "same_call_once_on_timeout";
    depends_on: string[];
    purpose: string;
  }>,
): StepDirective["execution_plan"]["calls"][number] {
  return {
    id: overrides?.id ?? tool.replaceAll(".", "_"),
    tool,
    input,
    origin: overrides?.origin ?? "builtin",
    source_refs: overrides?.source_refs ?? [],
    retry_policy: overrides?.retry_policy ?? "none",
    depends_on: overrides?.depends_on ?? [],
    purpose: overrides?.purpose ?? `Run ${tool}`,
  };
}

function autonomousPlan(
  allowedTools: string[] = ["shell"],
  maxCalls = 4,
): StepDirective["execution_plan"] {
  return {
    mode: "autonomous",
    calls: [],
    allowed_tools: allowedTools,
    max_calls: maxCalls,
  };
}

function concretePlan(
  mode: "single" | "sequential" | "parallel",
  calls: StepDirective["execution_plan"]["calls"],
): StepDirective["execution_plan"] {
  return {
    mode,
    calls,
    allowed_tools: [],
  };
}

function createDirective(overrides?: Partial<StepDirective>): StepDirective {
  return {
    done: false,
    contract_version: 2,
    execution_contract: "run a shell command",
    execution_plan: autonomousPlan(["shell"], 4),
    success_criteria: "command output returned",
    context: "",
    verification: {
      policy: "llm",
      rationale: "Test fixture requires semantic validation.",
      expected_artifacts: [],
      expected_state_change: "The step result is available for validation.",
      requires_full_step_context: false,
    },
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
        config: { ...DEFAULT_LOOP_CONFIG, maxToolCallsPerStep: 1 },
        clientId: "c1",
        sessionMemory,
        runHandle,
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(deps, createDirective(), 1, runPath);
      expect(summary.outcome).toBe("failed");
      expect(summary.toolSuccessCount).toBe(0);
      expect(summary.toolFailureCount).toBe(1);
      expect(summary.taskProgress?.status).toBe("not_done");
      expect(summary.newFacts).toEqual([]);
      expect(summary.artifacts).toContain("steps/001-act.md");
      expect(summary.artifacts).toContain("steps/001-verify.md");
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);

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

      const summary = await executeStep(
        deps,
        createDirective({ execution_plan: autonomousPlan(["shell_run_script"], 4) }),
        1,
        runPath,
      );
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

  it("allows any explicitly allowed built-in tool during autonomous act", async () => {
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
        createDirective({
          execution_plan: autonomousPlan(["read_file"], 4),
          verification: {
            policy: "script",
            rationale: "read_file success with the requested package.json path is enough for this local executor assertion.",
            expected_artifacts: ["package.json"],
            expected_state_change: "package.json is read successfully.",
            requires_full_step_context: false,
          },
        }),
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

  it("passes only autonomous allowed tool schemas to the act model", async () => {
    const { runPath, cleanup } = setup();
    try {
      const turnInputs: LlmTurnInput[] = [];
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
          turnInputs.push(input);
          return {
            type: "tool_calls",
            calls: [{ id: "tc1", name: "read_file", input: { path: "package.json" } }],
          };
        }),
      };

      const readFileExecute = vi.fn().mockResolvedValue({
        ok: true,
        output: "{\"name\":\"ayati\"}",
        meta: { filePath: "package.json" },
      });
      const toolExecutor: ToolExecutor = {
        list: () => ["shell", "read_file", "write_file"],
        definitions: () => [
          {
            name: "shell",
            description: "Run shell",
            inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
            execute: vi.fn(),
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            execute: readFileExecute,
          },
          {
            name: "write_file",
            description: "Write a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            execute: vi.fn(),
          },
        ],
        execute: vi.fn().mockImplementation(async (_toolName: string, input: unknown) => readFileExecute(input)),
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
        createDirective({
          execution_plan: autonomousPlan(["read_file"], 4),
          success_criteria: "read package.json",
          verification: {
            policy: "script",
            rationale: "read_file success with a matching path is enough for this local executor assertion.",
            expected_artifacts: ["package.json"],
            expected_state_change: "package.json is read successfully.",
            requires_full_step_context: false,
          },
        }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(turnInputs[0]?.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
    } finally {
      cleanup();
    }
  });

  it("executes multiple autonomous read-only tool calls in one model turn", async () => {
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
            { id: "read-a", name: "read_file", input: { path: "a.md" } },
            { id: "read-b", name: "read_file", input: { path: "b.md" } },
          ],
        }),
      };

      const executeSpy = vi.fn().mockImplementation(async (_toolName: string, input: unknown) => {
        const path = (input as { path?: string }).path;
        return {
          ok: true,
          output: path === "a.md" ? "alpha content for first file" : "beta content for second file",
          meta: { filePath: path },
        };
      });
      const toolExecutor: ToolExecutor = {
        list: () => ["read_file"],
        definitions: () => [{
          name: "read_file",
          description: "Read file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          execute: vi.fn(),
        }],
        execute: executeSpy,
        validate: vi.fn().mockReturnValue({ valid: true }),
      };

      const deps: ExecutorDeps = {
        provider,
        toolExecutor,
        toolDefinitions: toolExecutor.definitions(),
        config: { ...DEFAULT_LOOP_CONFIG, maxInlineActOutputChars: 8 },
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({
          execution_plan: autonomousPlan(["read_file"], 2),
          success_criteria: "read both files",
          verification: {
            policy: "script",
            rationale: "read_file success with both expected paths is enough for this local executor assertion.",
            expected_artifacts: ["a.md", "b.md"],
            expected_state_change: "Both files are read successfully.",
            requires_full_step_context: false,
          },
        }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(summary.verificationMethod).toBe("script");
      expect(summary.toolSuccessCount).toBe(2);
      expect(provider.generateTurn).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(summary.usedRawArtifacts).toEqual([
        "steps/001-call-01-raw.txt",
        "steps/001-call-02-raw.txt",
      ]);
      expect(readFileSync(join(runPath, "steps", "001-call-01-raw.txt"), "utf-8")).toContain("alpha content");
      expect(readFileSync(join(runPath, "steps", "001-call-02-raw.txt"), "utf-8")).toContain("beta content");
    } finally {
      cleanup();
    }
  });

  it("fails mixed-phase autonomous plans locally", async () => {
    const { runPath, cleanup } = setup();
    try {
      const provider: LlmProvider = {
        name: "mock",
        version: "1.0.0",
        capabilities: { nativeToolCalling: true },
        start: vi.fn(),
        stop: vi.fn(),
        generateTurn: vi.fn(),
      };

      const toolExecutor: ToolExecutor = {
        list: () => ["shell", "read_file"],
        definitions: () => [
          {
            name: "shell",
            description: "Run shell",
            inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
            execute: vi.fn(),
          },
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: { type: "object", properties: { path: { type: "string" } } },
            execute: vi.fn(),
          },
        ],
        execute: vi.fn(),
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
        createDirective({ execution_plan: autonomousPlan(["shell", "read_file"], 4) }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("failed");
      expect(summary.toolSuccessCount).toBe(0);
      expect(summary.toolFailureCount).toBe(1);
      expect(summary.summary).toContain("Step failed during tool execution");
      expect(summary.evidenceSummary).toContain("mixes incompatible tool phases");
      expect(provider.generateTurn).not.toHaveBeenCalled();
      expect(toolExecutor.execute).not.toHaveBeenCalled();
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

      const summary = await executeStep(
        deps,
        createDirective({ execution_plan: autonomousPlan(["shell"], 4) }),
        1,
        runPath,
      );
      expect(summary.toolSuccessCount).toBe(1);
      expect(executeSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("runs sequential planned directives in order", async () => {
    const { runPath, cleanup } = setup();
    try {
      const executeSpy = vi.fn().mockResolvedValue({ ok: true, output: "ok" });
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
              summary: "Verified that both planned shell calls ran in order.",
              evidenceSummary: "The sequential plan executed both commands.",
              evidenceItems: ["echo one", "echo two"],
            }),
          })
          .mockResolvedValueOnce({
            type: "assistant",
            content: taskVerifyResponse("done", "sequential calls completed", ["two shell calls"]),
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
        execution_plan: concretePlan("sequential", [
          planCall("shell", { cmd: "echo one" }, { id: "first", purpose: "Echo one" }),
          planCall("shell", { cmd: "echo two" }, { id: "second", depends_on: ["first"], purpose: "Echo two after one" }),
        ]),
      }), 1, runPath);

      expect(summary.outcome).toBe("success");
      expect(summary.stoppedEarlyReason).toBeUndefined();
      expect(summary.toolSuccessCount).toBe(2);
      expect(summary.toolFailureCount).toBe(0);
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(executeSpy).toHaveBeenNthCalledWith(1, "shell", { cmd: "echo one" }, expect.any(Object));
      expect(executeSpy).toHaveBeenNthCalledWith(2, "shell", { cmd: "echo two" }, expect.any(Object));
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
        execution_plan: concretePlan("single", [
          planCall("demo-search.query", {}, { origin: "external_tool", purpose: "Run external query" }),
        ]),
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
        execution_plan: concretePlan("single", [
          planCall("demo-search.query", {}, { origin: "external_tool", purpose: "Run external query" }),
        ]),
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
        execution_plan: concretePlan("single", [
          planCall("shell", { cmd: "echo huge" }, { purpose: "Generate large output" }),
        ]),
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
        config: { ...DEFAULT_LOOP_CONFIG, maxToolCallsPerStep: 7, maxTotalToolCallsPerStep: 6 },
        clientId: "c1",
        sessionMemory: createMockSessionMemory(),
        runHandle: { sessionId: "s1", runId: "r1" },
        taskContext: createTaskContext(),
      };

      const summary = await executeStep(
        deps,
        createDirective({ execution_plan: autonomousPlan(["shell"], 6) }),
        1,
        runPath,
      );
      expect(summary.toolSuccessCount).toBe(6);
      expect(summary.stoppedEarlyReason).toBe("max_total_tool_calls_reached");
      expect(summary.summary).not.toBe("");
    } finally {
      cleanup();
    }
  });

  it("uses a local wrap-up when tool execution ends without assistant text", async () => {
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
              content: JSON.stringify({
                step: {
                  passed: true,
                  summary: "Verified that the captured shell output hello satisfies the step.",
                  evidenceSummary: "The shell output confirmed hello was captured.",
                  evidenceItems: ["shell output: hello"],
                  newFacts: [],
                  artifacts: [],
                },
                taskProgress: {
                  status: "done",
                  progressSummary: "command output satisfied the goal",
                  currentFocus: "Complete.",
                  completedMilestones: ["command output captured"],
                  openWork: [],
                  blockers: [],
                  keyFacts: [],
                  evidence: ["command output: hello"],
                },
              }),
            };
          }
          return {
            type: "assistant",
            content: stepVerifyResponse({
              summary: "Verified that the captured shell output hello satisfies the step.",
              evidenceSummary: "The assistant wrap-up and shell output both confirmed hello was captured.",
              evidenceItems: ["shell output: hello"],
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
        createDirective({ execution_plan: autonomousPlan(["shell"], 4) }),
        1,
        runPath,
      );

      expect(summary.outcome).toBe("success");
      expect(summary.stoppedEarlyReason).toBe("max_act_turns_reached");
      expect(summary.summary).toContain("captured shell output hello");
      expect(provider.generateTurn).toHaveBeenCalledTimes(2);
      expect(turnInputs[1]?.tools).toBeUndefined();

      const actMarkdown = readFileSync(join(runPath, "steps", "001-act.md"), "utf-8");
      expect(actMarkdown).toContain("## Final Text");
      expect(actMarkdown).toContain("stopped due to max_act_turns_reached");
      expect(actMarkdown).toContain("Successful results: shell: hello");
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
        createDirective({ execution_plan: autonomousPlan(["shell"], 4) }),
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
