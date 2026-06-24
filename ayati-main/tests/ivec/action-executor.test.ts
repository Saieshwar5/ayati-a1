import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeAgentAction } from "../../src/ivec/agent-runner/action-executor.js";
import type { AgentAction } from "../../src/ivec/agent-runner/decision.js";
import { DEFAULT_LOOP_CONFIG } from "../../src/ivec/types.js";
import type { WorkState } from "../../src/ivec/types.js";
import { noopSessionMemory } from "../../src/memory/provider.js";
import { writeFilesTool } from "../../src/skills/builtins/filesystem/write-files.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-action-executor-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function emptyWorkState(): WorkState {
  return {
    status: "not_done",
    summary: "",
    verifiedFacts: [],
    evidence: [],
  };
}

function actionFor(tool: string, input: Record<string, unknown>, purpose = "Run tool"): AgentAction {
  return {
    mode: "single",
    calls: [{
      id: "call_1",
      tool,
      input,
      dependsOn: [],
      purpose,
    }],
    allowedTools: [tool],
    assertions: [],
  };
}

function callSpec(id: string, tool: string, input: Record<string, unknown> = {}) {
  return {
    id,
    tool,
    input,
    dependsOn: [],
  };
}

async function runAction(tools: ToolDefinition[], action: AgentAction, runPath: string) {
  const toolExecutor = createToolExecutor(tools);
  return executeAgentAction(
    {
      toolExecutor,
      selectedTools: toolExecutor.definitions(),
      config: DEFAULT_LOOP_CONFIG,
      clientId: "c1",
      sessionMemory: noopSessionMemory,
      runHandle: { sessionId: "s1", runId: "r1" },
      runPath,
    },
    action,
    1,
    emptyWorkState(),
  );
}

describe("executeAgentAction verification gates", () => {
  it("rejects sequential actions above the configured per-step limit", async () => {
    const runPath = makeTmpDir();
    try {
      const tool = createTool("noop");
      const action: AgentAction = {
        mode: "sequential",
        calls: [
          callSpec("call_1", "noop"),
          callSpec("call_2", "noop"),
          callSpec("call_3", "noop"),
          callSpec("call_4", "noop"),
          callSpec("call_5", "noop"),
        ],
        allowedTools: ["noop"],
        assertions: [],
      };

      const result = await runAction([tool], action, runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("Sequential action requested 5 calls");
      expect(result.actOutput.toolCalls).toHaveLength(1);
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
      expect(result.nextWorkState.status).toBe("blocked");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects parallel actions above the configured per-step limit", async () => {
    const runPath = makeTmpDir();
    try {
      const tool = createTool("noop");
      const action: AgentAction = {
        mode: "parallel",
        calls: [
          callSpec("call_1", "noop"),
          callSpec("call_2", "noop"),
          callSpec("call_3", "noop"),
          callSpec("call_4", "noop"),
        ],
        allowedTools: ["noop"],
        assertions: [],
      };

      const result = await runAction([tool], action, runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("Parallel action requested 4 calls");
      expect(result.actOutput.toolCalls).toHaveLength(1);
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects invalid selected tool input during preflight before execution", async () => {
    const runPath = makeTmpDir();
    try {
      const result = await runAction([writeFilesTool], actionFor("write_files", {}), runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("Tool input preflight failed for 'write_files'");
      expect(result.verifyOutput.summary).toContain("missing required field 'files'");
      expect(result.actOutput.toolCalls).toHaveLength(1);
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
      expect(result.actOutput.toolCalls[0]?.error).toContain("received input keys: (none)");
    } finally {
      cleanup(runPath);
    }
  });

  it("records skipped sequential calls after a prior call fails", async () => {
    const runPath = makeTmpDir();
    let secondToolExecuted = false;
    try {
      const failTool: ToolDefinition = {
        name: "fail_tool",
        description: "Always fails.",
        inputSchema: { type: "object", additionalProperties: true },
        async execute() {
          return { ok: false, error: "boom" };
        },
      };
      const nextTool: ToolDefinition = {
        name: "next_tool",
        description: "Should be skipped.",
        inputSchema: { type: "object", additionalProperties: true },
        async execute() {
          secondToolExecuted = true;
          return { ok: true, output: "should not run" };
        },
      };
      const action: AgentAction = {
        mode: "sequential",
        calls: [
          callSpec("call_1", "fail_tool"),
          callSpec("call_2", "next_tool"),
        ],
        allowedTools: ["fail_tool", "next_tool"],
        assertions: [],
      };

      const result = await runAction([failTool, nextTool], action, runPath);

      expect(secondToolExecuted).toBe(false);
      expect(result.actOutput.toolCalls).toHaveLength(2);
      expect(result.actOutput.toolCalls[0]?.error).toBe("boom");
      expect(result.actOutput.toolCalls[1]?.error).toContain("Skipped because an earlier sequential call failed");
      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.executionStatus).toBe("all_failed");
      expect(result.nextWorkState.status).toBe("blocked");
    } finally {
      cleanup(runPath);
    }
  });

  it("records every parallel result and fails the step when any parallel call fails", async () => {
    const runPath = makeTmpDir();
    try {
      const okTool = createTool("calculator", { domain: "calculator" });
      const failTool: ToolDefinition = {
        name: "read_file",
        description: "Fails.",
        inputSchema: { type: "object", additionalProperties: true },
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
          return { ok: false, error: "parallel boom" };
        },
      };
      const action: AgentAction = {
        mode: "parallel",
        calls: [
          callSpec("call_1", "calculator"),
          callSpec("call_2", "read_file"),
          callSpec("call_3", "calculator"),
        ],
        allowedTools: ["calculator", "read_file"],
        assertions: [],
      };

      const result = await runAction([okTool, failTool], action, runPath);

      expect(result.actOutput.toolCalls).toHaveLength(3);
      expect(result.actOutput.toolCalls.map((call) => call.callId)).toEqual(["call_1", "call_2", "call_3"]);
      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.executionStatus).toBe("partial_success");
      expect(result.verifyOutput.summary).toContain("read_file: parallel boom");
      expect(result.nextWorkState.status).toBe("blocked");
    } finally {
      cleanup(runPath);
    }
  });

  it("allows explicitly safe read-only tools in parallel", async () => {
    const runPath = makeTmpDir();
    try {
      const calculator = createTool("calculator", { domain: "calculator" });
      const searchInFiles = createTool("search_in_files", { domain: "filesystem", readOnly: true });
      const action: AgentAction = {
        mode: "parallel",
        calls: [
          callSpec("call_1", "calculator", { expression: "1 + 1" }),
          callSpec("call_2", "search_in_files", { path: ".", query: "test" }),
        ],
        allowedTools: ["calculator", "search_in_files"],
        assertions: [],
      };

      const result = await runAction([calculator, searchInFiles], action, runPath);

      expect(result.verifyOutput.passed).toBe(true);
      expect(result.actOutput.toolCalls).toHaveLength(2);
      expect(result.actOutput.toolCalls.map((call) => call.callId)).toEqual(["call_1", "call_2"]);
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects unannotated tools in parallel before execution", async () => {
    const runPath = makeTmpDir();
    let executed = false;
    try {
      const unannotatedTool: ToolDefinition = {
        name: "unknown_safe",
        description: "Missing annotations.",
        inputSchema: { type: "object", additionalProperties: true },
        async execute() {
          executed = true;
          return { ok: true, output: "should not run" };
        },
      };
      const action: AgentAction = {
        mode: "parallel",
        calls: [callSpec("call_1", "unknown_safe")],
        allowedTools: ["unknown_safe"],
        assertions: [],
      };

      const result = await runAction([unannotatedTool], action, runPath);

      expect(executed).toBe(false);
      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("has no safety annotations");
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects non-allowlisted tools in parallel", async () => {
    const runPath = makeTmpDir();
    try {
      const shellTool = createTool("shell", {
        domain: "shell",
        readOnly: false,
        mutatesWorkspace: true,
        mutatesExternalWorld: true,
        idempotent: false,
        retrySafe: false,
      });
      const action: AgentAction = {
        mode: "parallel",
        calls: [callSpec("call_1", "shell", { cmd: "pwd" })],
        allowedTools: ["shell"],
        assertions: [],
      };

      const result = await runAction([shellTool], action, runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("tool 'shell' is not parallel-safe");
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects long-running or retry-unsafe tools in parallel", async () => {
    const runPath = makeTmpDir();
    try {
      const longRunningRead = createTool("read_file", {
        domain: "filesystem",
        readOnly: true,
        longRunning: true,
      });
      const retryUnsafeList = createTool("list_directory", {
        domain: "filesystem",
        readOnly: true,
        retrySafe: false,
      });

      const longRunningResult = await runAction([longRunningRead], {
        mode: "parallel",
        calls: [callSpec("call_1", "read_file", { path: "a.txt" })],
        allowedTools: ["read_file"],
        assertions: [],
      }, runPath);
      const retryUnsafeResult = await runAction([retryUnsafeList], {
        mode: "parallel",
        calls: [callSpec("call_1", "list_directory", { path: "." })],
        allowedTools: ["list_directory"],
        assertions: [],
      }, runPath);

      expect(longRunningResult.verifyOutput.passed).toBe(false);
      expect(longRunningResult.verifyOutput.summary).toContain("is long-running");
      expect(retryUnsafeResult.verifyOutput.passed).toBe(false);
      expect(retryUnsafeResult.verifyOutput.summary).toContain("is not retry-safe");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects mixed safe and unsafe parallel actions before execution", async () => {
    const runPath = makeTmpDir();
    let safeExecuted = false;
    let unsafeExecuted = false;
    try {
      const calculator = createTool("calculator", { domain: "calculator" }, () => {
        safeExecuted = true;
      });
      const writeFiles = createTool("write_files", { domain: "filesystem", readOnly: false, mutatesWorkspace: true }, () => {
        unsafeExecuted = true;
      });
      const action: AgentAction = {
        mode: "parallel",
        calls: [
          callSpec("call_1", "calculator", { expression: "2 + 2" }),
          callSpec("call_2", "write_files", { files: [{ path: "site/index.html", content: "" }] }),
        ],
        allowedTools: ["calculator", "write_files"],
        assertions: [],
      };

      const result = await runAction([calculator, writeFiles], action, runPath);

      expect(safeExecuted).toBe(false);
      expect(unsafeExecuted).toBe(false);
      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("tool 'write_files' is not parallel-safe");
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
    } finally {
      cleanup(runPath);
    }
  });

  it("rejects mutating filesystem calls in parallel", async () => {
    const runPath = makeTmpDir();
    try {
      const createDir = createTool("create_directory", { domain: "filesystem", readOnly: false });
      const writeFiles = createTool("write_files", { domain: "filesystem", readOnly: false });
      const action: AgentAction = {
        mode: "parallel",
        calls: [
          callSpec("call_1", "create_directory", { path: "site" }),
          callSpec("call_2", "write_files", { files: [{ path: "site/index.html", content: "" }] }),
        ],
        allowedTools: ["create_directory", "write_files"],
        assertions: [],
      };

      const result = await runAction([createDir, writeFiles], action, runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.summary).toContain("tool 'create_directory' is not parallel-safe");
      expect(result.actOutput.toolCalls[0]?.tool).toBe("execution_plan");
    } finally {
      cleanup(runPath);
    }
  });

  it("uses the execution gate when every tool call fails", async () => {
    const runPath = makeTmpDir();
    try {
      const failingTool: ToolDefinition = {
        name: "fail_tool",
        description: "Always fails.",
        inputSchema: { type: "object", additionalProperties: true },
        async execute() {
          return { ok: false, error: "boom" };
        },
      };

      const result = await runAction([failingTool], actionFor("fail_tool", {}), runPath);

      expect(result.verifyOutput.passed).toBe(false);
      expect(result.verifyOutput.method).toBe("execution_gate");
      expect(result.verifyOutput.executionStatus).toBe("all_failed");
      expect(result.verifyOutput.validationStatus).toBe("skipped");
      expect(result.verifyOutput.evidenceItems).toContain("fail_tool: boom");
      expect(result.nextWorkState.status).toBe("blocked");
    } finally {
      cleanup(runPath);
    }
  });

  it("uses the deterministic success gate for known deterministic tool output without a contract", async () => {
    const runPath = makeTmpDir();
    try {
      const datasetQueryTool: ToolDefinition = {
        name: "dataset_query",
        description: "Return deterministic dataset rows.",
        inputSchema: { type: "object", additionalProperties: true },
        async execute() {
          return {
            ok: true,
            output: JSON.stringify({
              rows: [{ count: 2 }],
              rowCount: 1,
              columns: ["count"],
            }),
          };
        },
      };

      const result = await runAction(
        [datasetQueryTool],
        actionFor("dataset_query", { sql: "select count(*) as count from items" }, "Return dataset count"),
        runPath,
      );

      expect(result.verifyOutput.passed).toBe(true);
      expect(result.verifyOutput.method).toBe("script");
      expect(result.verifyOutput.executionStatus).toBe("all_succeeded");
      expect(result.verifyOutput.validationStatus).toBe("passed");
      expect(result.verifyOutput.evidenceSummary).toContain("dataset_query succeeded");
      expect(result.nextWorkState.verifiedFacts.some((fact) => fact.includes("dataset_query succeeded"))).toBe(true);
    } finally {
      cleanup(runPath);
    }
  });

  it("preserves contract-backed facts when deterministic filesystem work succeeds", async () => {
    const runPath = makeTmpDir();
    const outputPath = join(runPath, "created.txt");
    try {
      const result = await runAction(
        [writeFilesTool],
        actionFor("write_files", {
          files: [{ path: outputPath, content: "created by verification gate test" }],
        }, "Create requested file"),
        runPath,
      );

      expect(result.verifyOutput.passed).toBe(true);
      expect(result.verifyOutput.method).toBe("script");
      expect(result.verifyOutput.artifacts).toContain(outputPath);
      expect(result.nextWorkState.status).toBe("not_done");
      expect(result.nextWorkState.verifiedFacts.some((fact) => fact.includes("Read-back hash verified"))).toBe(true);
      expect(existsSync(outputPath)).toBe(true);
    } finally {
      cleanup(runPath);
    }
  });
});

function createTool(
  name: string,
  annotations?: Partial<NonNullable<ToolDefinition["annotations"]>>,
  onExecute?: () => void,
): ToolDefinition {
  return {
    name,
    description: `${name} test tool.`,
    inputSchema: { type: "object", additionalProperties: true },
    ...(annotations ? {
      annotations: {
        domain: annotations.domain ?? "general",
        readOnly: annotations.readOnly ?? true,
        mutatesWorkspace: annotations.mutatesWorkspace ?? false,
        mutatesExternalWorld: annotations.mutatesExternalWorld ?? false,
        destructive: annotations.destructive ?? false,
        idempotent: annotations.idempotent ?? true,
        retrySafe: annotations.retrySafe ?? true,
        longRunning: annotations.longRunning ?? false,
      },
    } : {}),
    async execute() {
      onExecute?.();
      return { ok: true, output: `${name} ok` };
    },
  };
}
