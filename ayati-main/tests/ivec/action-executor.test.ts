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
    maxCalls: 1,
    assertions: [],
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
