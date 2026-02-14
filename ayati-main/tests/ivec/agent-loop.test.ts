import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from "../../src/ivec/agent-loop.js";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import type { SessionMemory, MemoryRunHandle } from "../../src/memory/types.js";
import type { ContextRecallService } from "../../src/ivec/context-recall-service.js";
import type { ToolExecutor } from "../../src/skills/tool-executor.js";
import { AGENT_STEP_TOOL_NAME } from "../../src/ivec/agent-step-tool.js";
import { CONTEXT_RECALL_TOOL_NAME } from "../../src/ivec/tool-helpers.js";

function createMockProvider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    name: "mock",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true },
    start: vi.fn(),
    stop: vi.fn(),
    generateTurn: vi
      .fn<(input: LlmTurnInput) => Promise<LlmTurnOutput>>()
      .mockResolvedValue({ type: "assistant", content: "mock reply" }),
    ...overrides,
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
      toolEvents: [],
    }),
    setStaticTokenBudget: vi.fn(),
    searchSessionSummaries: vi.fn().mockReturnValue([]),
    loadSessionTurns: vi.fn().mockReturnValue([]),
  };
}

function createMockContextRecall(): ContextRecallService {
  return {
    recall: vi.fn().mockResolvedValue({
      status: "not_found",
      reason: "mock",
      searchedSessionIds: [],
      evidence: [],
      modelCalls: 0,
      elapsedMs: 0,
    }),
  } as unknown as ContextRecallService;
}

function createMockToolExecutor(overrides?: Partial<ToolExecutor>): ToolExecutor {
  return {
    list: () => ["shell"],
    definitions: () => [{
      name: "shell",
      description: "Run shell",
      inputSchema: { type: "object", properties: { cmd: { type: "string" } } },
      execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
    }],
    execute: vi.fn().mockResolvedValue({ ok: true, output: "hello" }),
    validate: vi.fn().mockReturnValue({ valid: true }),
    ...overrides,
  };
}

const runHandle: MemoryRunHandle = { sessionId: "s1", runId: "r1" };
const resolveModel = () => "mock-model";

describe("AgentLoop", () => {
  it("simple REASON → END returns reply", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            calls: [{
              id: "s1",
              name: AGENT_STEP_TOOL_NAME,
              input: { phase: "reason", thinking: "Simple question", summary: "Analyzing" },
            }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{
            id: "s2",
            name: AGENT_STEP_TOOL_NAME,
            input: { phase: "end", thinking: "Done", summary: "Answering", end_status: "solved", end_message: "The answer is 42." },
          }],
        };
      }),
    });

    const loop = new AgentLoop(provider, undefined, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "what is 42?", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.content).toBe("The answer is 42.");
    expect(result.endStatus).toBe("solved");
    expect(result.totalSteps).toBe(2);
  });

  it("REASON → ACT → VERIFY → END with tool use", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { type: "tool_calls", calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "Need to run command", summary: "Planning" } }] };
        }
        if (callCount === 2) {
          return { type: "tool_calls", calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "act", thinking: "Running echo", summary: "Execute shell", action: { tool_name: "shell", tool_input: { cmd: "echo hello" } } } }] };
        }
        if (callCount === 3) {
          return { type: "tool_calls", calls: [{ id: "s3", name: AGENT_STEP_TOOL_NAME, input: { phase: "verify", thinking: "Output looks correct", summary: "Checking result" } }] };
        }
        return { type: "tool_calls", calls: [{ id: "s4", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "All done", summary: "Complete", end_status: "solved", end_message: "Command output: hello" } }] };
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "echo hello", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.content).toBe("Command output: hello");
    expect(result.toolCallsMade).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledWith("shell", { cmd: "echo hello" }, { clientId: "c1" });
  });

  it("reflection: REASON → ACT → VERIFY(fail) → REFLECT → ACT → VERIFY → END", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor({
      execute: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "not found" })
        .mockResolvedValueOnce({ ok: true, output: "found it" }),
    });
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        switch (callCount) {
          case 1: return { type: "tool_calls", calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "t", summary: "Plan" } }] };
          case 2: return { type: "tool_calls", calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "act", thinking: "t", summary: "Try 1", action: { tool_name: "shell", tool_input: { path: "/a" } } } }] };
          case 3: return { type: "tool_calls", calls: [{ id: "s3", name: AGENT_STEP_TOOL_NAME, input: { phase: "verify", thinking: "Failed", summary: "Check" } }] };
          case 4: return { type: "tool_calls", calls: [{ id: "s4", name: AGENT_STEP_TOOL_NAME, input: { phase: "reflect", thinking: "Wrong path", summary: "Reflect", approaches_tried: ["path /a"] } }] };
          case 5: return { type: "tool_calls", calls: [{ id: "s5", name: AGENT_STEP_TOOL_NAME, input: { phase: "act", thinking: "t", summary: "Try 2", action: { tool_name: "shell", tool_input: { path: "/b" } } } }] };
          case 6: return { type: "tool_calls", calls: [{ id: "s6", name: AGENT_STEP_TOOL_NAME, input: { phase: "verify", thinking: "OK", summary: "Check" } }] };
          default: return { type: "tool_calls", calls: [{ id: "s7", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "Found it" } }] };
        }
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "find file", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.endStatus).toBe("solved");
    expect(result.toolCallsMade).toBe(2);
  });

  it("FEEDBACK returns feedback result", async () => {
    let callCount = 0;
    const memory = createMockSessionMemory();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { type: "tool_calls", calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "Unclear", summary: "Analyzing" } }] };
        }
        return { type: "tool_calls", calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "feedback", thinking: "Need clarification", summary: "Asking", feedback_message: "Which format do you prefer?" } }] };
      }),
    });

    const loop = new AgentLoop(provider, undefined, memory, createMockContextRecall());
    const result = await loop.run("c1", "convert this", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("feedback");
    expect(result.content).toBe("Which format do you prefer?");
    expect(memory.recordAssistantFeedback).toHaveBeenCalledWith("c1", "r1", "s1", "Which format do you prefer?");
  });

  it("step limit exceeded returns stuck", async () => {
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        return { type: "tool_calls", calls: [{ id: `s-${Date.now()}`, name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "Still thinking...", summary: "Thinking" } }] };
      }),
    });

    const loop = new AgentLoop(provider, undefined, createMockSessionMemory(), createMockContextRecall(), undefined, { noProgressLimit: 20, baseStepLimit: 3, maxStepLimit: 3 });
    const result = await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect(result.endStatus).toBe("stuck");
    expect(result.totalSteps).toBe(3);
  });

  it("no-progress limit (consecutive non-ACT) forces end", async () => {
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        return { type: "tool_calls", calls: [{ id: `s-${Date.now()}`, name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "Thinking...", summary: "Still thinking" } }] };
      }),
    });

    const loop = new AgentLoop(provider, undefined, createMockSessionMemory(), createMockContextRecall(), undefined, { noProgressLimit: 4, baseStepLimit: 20, maxStepLimit: 20 });
    const result = await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect(result.endStatus).toBe("stuck");
    expect(result.totalSteps).toBe(4);
  });

  it("plain text response (implicit END) is backward compatible", async () => {
    const provider = createMockProvider({
      generateTurn: vi.fn().mockResolvedValue({ type: "assistant", content: "Direct answer" }),
    });

    const loop = new AgentLoop(provider, undefined, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "hi", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.content).toBe("Direct answer");
    expect(result.endStatus).toBe("solved");
  });

  it("scratchpad accumulates across steps", async () => {
    let callCount = 0;
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
        callCount++;
        if (callCount === 1) {
          return { type: "tool_calls", calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "First thought", summary: "Step 1" } }] };
        }
        if (callCount === 2) {
          const sys = input.messages.find((m) => m.role === "system");
          const content = sys && "content" in sys ? sys.content : "";
          expect(content).toContain("Scratchpad");
          expect(content).toContain("Step 1");
          return { type: "tool_calls", calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "OK" } }] };
        }
        return { type: "assistant", content: "fallback" };
      }),
    });

    const loop = new AgentLoop(provider, undefined, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "test", "Base system prompt", 0, runHandle, 0, resolveModel);

    expect(result.content).toBe("OK");
  });

  it("direct tool call (non-agent_step) executes tool and continues loop", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor();
    const toolDefs = toolExecutor.definitions();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            calls: [{ id: "t1", name: "shell", input: { cmd: "echo hi" } }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "Got: hello" } }],
        };
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall(), undefined, undefined, toolDefs);
    const result = await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.endStatus).toBe("solved");
    expect(result.content).toBe("Got: hello");
    expect(result.toolCallsMade).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledWith("shell", { cmd: "echo hi" }, { clientId: "c1" });
  });

  it("mixed direct tool call + agent_step in same response works", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor();
    const toolDefs = toolExecutor.definitions();
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            calls: [
              { id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "reason", thinking: "Planning", summary: "Plan" } },
            ],
          };
        }
        if (callCount === 2) {
          return {
            type: "tool_calls",
            calls: [{ id: "t1", name: "shell", input: { cmd: "echo mixed" } }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "Mixed result" } }],
        };
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall(), undefined, undefined, toolDefs);
    const result = await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.endStatus).toBe("solved");
    expect(result.toolCallsMade).toBe(1);
    expect(toolExecutor.execute).toHaveBeenCalledWith("shell", { cmd: "echo mixed" }, { clientId: "c1" });
  });

  it("validation failure returns schema in tool result for self-correction", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor({
      validate: vi.fn()
        .mockReturnValueOnce({
          valid: false,
          error: "Invalid input for 'shell': missing required field 'cmd'",
          schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        })
        .mockReturnValueOnce({ valid: true }),
      execute: vi.fn().mockResolvedValue({ ok: true, output: "done" }),
    });
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { type: "tool_calls", calls: [{ id: "s1", name: AGENT_STEP_TOOL_NAME, input: { phase: "act", thinking: "t", summary: "Try bad input", action: { tool_name: "shell", tool_input: {} } } }] };
        }
        if (callCount === 2) {
          return { type: "tool_calls", calls: [{ id: "s2", name: AGENT_STEP_TOOL_NAME, input: { phase: "act", thinking: "t", summary: "Fix input", action: { tool_name: "shell", tool_input: { cmd: "echo hi" } } } }] };
        }
        return { type: "tool_calls", calls: [{ id: "s3", name: AGENT_STEP_TOOL_NAME, input: { phase: "end", thinking: "Done", summary: "Done", end_status: "solved", end_message: "Fixed" } }] };
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.content).toBe("Fixed");
    expect(result.toolCallsMade).toBe(2);
    expect(toolExecutor.validate).toHaveBeenCalledTimes(2);
    expect(toolExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it("includes native tool schemas alongside agent_step in tools array", async () => {
    let capturedTools: unknown[] = [];
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async (input: LlmTurnInput) => {
        capturedTools = input.tools;
        return { type: "assistant", content: "reply" };
      }),
    });

    const toolExecutor = createMockToolExecutor();
    const toolDefs = toolExecutor.definitions();
    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall(), undefined, undefined, toolDefs);
    await loop.run("c1", "test", "", 0, runHandle, 0, resolveModel);

    expect((capturedTools[0] as { name: string }).name).toBe(AGENT_STEP_TOOL_NAME);
    const names = (capturedTools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toContain("shell");
    expect(names).toContain(CONTEXT_RECALL_TOOL_NAME);
  });

  it("blocks repeated identical tool calls after threshold", async () => {
    let callCount = 0;
    const toolExecutor = createMockToolExecutor({
      execute: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
    });
    const provider = createMockProvider({
      generateTurn: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 4) {
          return {
            type: "tool_calls",
            calls: [{
              id: `s${callCount}`,
              name: AGENT_STEP_TOOL_NAME,
              input: {
                phase: "act",
                thinking: "repeat",
                summary: "repeat",
                action: { tool_name: "shell", tool_input: { cmd: "echo hi" } },
              },
            }],
          };
        }
        return {
          type: "tool_calls",
          calls: [{
            id: "end",
            name: AGENT_STEP_TOOL_NAME,
            input: {
              phase: "end",
              thinking: "done",
              summary: "done",
              end_status: "solved",
              end_message: "completed",
            },
          }],
        };
      }),
    });

    const loop = new AgentLoop(provider, toolExecutor, createMockSessionMemory(), createMockContextRecall());
    const result = await loop.run("c1", "repeat command", "", 0, runHandle, 0, resolveModel);

    expect(result.type).toBe("reply");
    expect(result.endStatus).toBe("solved");
    expect(toolExecutor.execute).toHaveBeenCalledTimes(3);
  });
});
