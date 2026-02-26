import { describe, it, expect, vi } from "vitest";
import { parseControllerResponse, callController } from "../../src/ivec/controller.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { LoopState } from "../../src/ivec/types.js";
import type { ToolDefinition } from "../../src/skills/types.js";

function createMockProvider(response: string): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({ type: "assistant", content: response }),
  };
}

function createState(overrides?: Partial<LoopState>): LoopState {
  return {
    runId: "r1",
    userMessage: "hello",
    goal: "greet user",
    approach: "direct",
    status: "running",
    iteration: 0,
    maxIterations: 15,
    consecutiveFailures: 0,
    facts: [],
    uncertainties: [],
    completedSteps: [],
    runPath: "/tmp/test",
    ...overrides,
  };
}

describe("parseControllerResponse", () => {
  it("parses StepDirective JSON", () => {
    const json = JSON.stringify({
      done: false,
      intent: "read file",
      type: "tool_use",
      tools_hint: ["read_file"],
      success_criteria: "file content returned",
      context: "need to check config",
    });
    const result = parseControllerResponse(json);
    expect(result.done).toBe(false);
    if (!result.done) {
      expect(result.intent).toBe("read file");
      expect(result.tools_hint).toEqual(["read_file"]);
    }
  });

  it("parses CompletionDirective JSON", () => {
    const json = JSON.stringify({
      done: true,
      summary: "Task completed successfully",
      status: "completed",
    });
    const result = parseControllerResponse(json);
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("Task completed successfully");
      expect(result.status).toBe("completed");
    }
  });

  it("handles JSON wrapped in ```json fences", () => {
    const text = '```json\n{ "done": true, "summary": "done", "status": "completed" }\n```';
    const result = parseControllerResponse(text);
    expect(result.done).toBe(true);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseControllerResponse("not json")).toThrow();
  });
});

describe("callController", () => {
  const shellTool: ToolDefinition = {
    name: "shell",
    description: "Run a shell command and return its output",
    inputSchema: {
      type: "object",
      required: ["cmd"],
      properties: { cmd: { type: "string", description: "The command to run" } },
    },
    execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
  };

  it("with mock provider returns parsed output", async () => {
    const json = JSON.stringify({
      done: true,
      summary: "All done",
      status: "completed",
    });
    const provider = createMockProvider(json);
    const state = createState();

    const result = await callController(provider, state, [shellTool]);
    expect(result.done).toBe(true);
    if (result.done) {
      expect(result.summary).toBe("All done");
    }
    expect(provider.generateTurn).toHaveBeenCalledTimes(1);
  });

  it("includes tool descriptions in the prompt", async () => {
    const json = JSON.stringify({ done: true, summary: "ok", status: "completed" });
    const provider = createMockProvider(json);
    const state = createState();

    await callController(provider, state, [shellTool]);

    const call = (provider.generateTurn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { messages: Array<{ content: string }> };
    const prompt = call.messages[0]!.content;
    expect(prompt).toContain("shell");
    expect(prompt).toContain("Run a shell command");
    expect(prompt).toContain("cmd: string (required)");
  });
});
