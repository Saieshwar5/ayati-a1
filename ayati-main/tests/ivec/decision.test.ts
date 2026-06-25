import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { callAgentDecision, parseAgentDecision } from "../../src/ivec/agent-runner/decision.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type { ToolDefinition } from "../../src/skills/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("parseAgentDecision", () => {
  it("ignores model-provided action assertions", () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: { files: [] },
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
        assertions: [{
          id: "model_invented_check",
          kind: "html_contains",
          text: "Organic Vegetables",
        }],
      },
    }));

    expect(decision.kind).toBe("act");
    if (decision.kind !== "act") {
      throw new Error("Expected act decision.");
    }
    expect(decision.action.assertions).toEqual([]);
  });

  it("parses optional working notes", () => {
    const decision = parseAgentDecision(JSON.stringify({
      kind: "reply",
      status: "completed",
      message: "Done",
      workingNotes: ["  RAM used is 3.5Gi.  ", ""],
    }));

    expect(decision.kind).toBe("reply");
    expect(decision.workingNotes).toEqual(["RAM used is 3.5Gi."]);
  });

  it("logs malformed decision responses to the daemon trace when enabled", async () => {
    vi.stubEnv("AYATI_AGENT_TRACE", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ message: "Hi!" }),
      JSON.stringify({ message: "Still missing kind" }),
    ]);

    await expect(callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    })).rejects.toThrow("Unsupported agent decision kind: undefined");

    const traceOutput = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(traceOutput).toContain("provider_request provider=fake-provider");
    expect(traceOutput).toContain("raw_response={\"message\":\"Hi!\"}");
    expect(traceOutput).toContain("parse_failed error=Unsupported agent decision kind: undefined");
    expect(traceOutput).toContain("repair_request reason=parse_failed");
  });

  it("does not log decision traces by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { provider } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(decision.kind).toBe("reply");
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps action-first semantics in the stable decision prompt", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ]);

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    const messages = generateTurn.mock.calls[0]?.[0]?.messages ?? [];
    const systemPrompt = messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("Autonomous execution policy: for actionable user requests, prefer progress over discussion.");
    expect(systemPrompt).toContain("Call exactly one native tool");
    expect(systemPrompt).toContain("Use reply only as a terminal decision");
    expect(systemPrompt).toContain("Do not use decision_reply to say you will do future work.");
    expect(systemPrompt).toContain("call the selected executable tool directly");
    expect(systemPrompt).toContain("Use ask_user only for hard blockers");
    expect(systemPrompt).toContain("Do not ask_user for style, wording, organization, or preference choices");
    expect(systemPrompt).toContain("Do not tell the user tools are missing.");
    expect(systemPrompt).not.toContain("decision_act");
  });

  it("repairs act decisions that reference unselected tools into load_tools", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "sequential",
        calls: [
          {
            id: "call_1",
            tool: "shell",
            input: { command: "pwd" },
            dependsOn: [],
          },
          {
            id: "call_2",
            tool: "load_tools",
            input: { groups: ["skill:shell"] },
            dependsOn: [],
          },
        ],
        allowedTools: ["shell", "load_tools"],
      },
    };
    const repaired = {
      kind: "load_tools",
      request: {
        groups: ["skill:shell"],
        reason: "Need shell to run a command.",
      },
    };
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify(repaired),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(decision.kind).toBe("load_tools");
    expect(generateTurn).toHaveBeenCalledTimes(2);
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("violates the Ayati tool protocol");
    expect(repairPrompt).toContain("Selected tools: (none)");
    expect(repairPrompt).toContain("Invalid tools in action.calls or allowedTools: shell, load_tools");
  });

  it("returns a failed reply after repeated tool protocol violations", async () => {
    const badAction = JSON.stringify({
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "shell",
          input: { command: "pwd" },
          dependsOn: [],
        }],
        allowedTools: ["shell"],
      },
    });
    const { provider, generateTurn } = createProvider([badAction, badAction, badAction]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn).toHaveBeenCalledTimes(3);
    expect(decision).toEqual({
      kind: "reply",
      status: "failed",
      message: "I could not form a valid tool call for this request.",
    });
  });

  it("allows act decisions that use selected tools", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({
        kind: "act",
        action: {
          mode: "single",
          calls: [{
            id: "call_1",
            tool: "shell",
            input: { command: "pwd" },
            dependsOn: [],
          }],
          allowedTools: ["shell"],
        },
      }),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("shell")],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("act");
  });

  it("uses native decision tools when supported", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ], { jsonSchema: true });

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [],
    });

    expect(generateTurn.mock.calls[0]?.[0]?.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "decision_reply",
      "decision_ask_user",
      "decision_load_tools",
    ]);
    expect(generateTurn.mock.calls[0]?.[0]?.toolChoice).toBe("required");
    expect(generateTurn.mock.calls[0]?.[0]?.parallelToolCalls).toBe(false);
  });

  it("exposes selected executable tools as native tools", async () => {
    const { provider, generateTurn } = createProvider([
      JSON.stringify({ kind: "reply", status: "completed", message: "Hi!" }),
    ], { jsonObject: true, jsonSchema: true });

    await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
        additionalProperties: false,
      })],
    });

    const tools = generateTurn.mock.calls[0]?.[0]?.tools ?? [];
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "decision_reply",
      "decision_ask_user",
      "decision_load_tools",
      "write_files",
    ]);
    expect(tools.find((tool: { name: string }) => tool.name === "write_files")?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["files", "taskCompletion"]),
      properties: {
        taskCompletion: {
          required: ["intent", "reason"],
          properties: {
            intent: {
              enum: ["not_completion", "completion_candidate"],
            },
          },
        },
      },
    });
  });

  it("converts a selected native executable tool call into an internal act decision", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: {
            files: [{ path: "site/index.html", content: "ok" }],
            createDirs: true,
            taskCompletion: {
              intent: "completion_candidate",
              reason: "This writes the requested site file.",
              expectedEvidence: ["site/index.html written"],
            },
          },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
          createDirs: { type: "boolean" },
        },
      })],
    });

    expect(generateTurn).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe("act");
    if (decision.kind !== "act") {
      throw new Error("Expected act decision.");
    }
    expect(decision.action).toMatchObject({
      mode: "single",
      allowedTools: ["write_files"],
      calls: [{
        id: "call_1",
        tool: "write_files",
        input: {
          files: [{ path: "site/index.html", content: "ok" }],
          createDirs: true,
        },
        dependsOn: [],
      }],
      completion: {
        intent: "completion_candidate",
        reason: "This writes the requested site file.",
        expectedEvidence: ["site/index.html written"],
      },
    });
  });

  it("repairs selected native executable calls with invalid input", async () => {
    const { provider, generateTurn } = createNativeToolProvider([
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: {},
        }],
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call_1",
          name: "write_files",
          input: { files: [{ path: "site/index.html", content: "ok" }] },
        }],
      },
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
      })],
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision.kind).toBe("act");
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("invalid tool input");
    expect(repairPrompt).toContain("missing required field 'files'");
    expect(repairPrompt).toContain("call the selected executable tool directly");
  });

  it("repairs act decisions with invalid selected tool input", async () => {
    const badAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: {},
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
      },
    };
    const repairedAction = {
      kind: "act",
      action: {
        mode: "single",
        calls: [{
          id: "call_1",
          tool: "write_files",
          input: { files: [{ path: "site/index.html", content: "ok" }] },
          dependsOn: [],
          purpose: "Create files",
        }],
        allowedTools: ["write_files"],
      },
    };
    const { provider, generateTurn } = createProvider([
      JSON.stringify(badAction),
      JSON.stringify(repairedAction),
    ]);

    const decision = await callAgentDecision({
      provider,
      stateView: createStateView(),
      toolDefinitions: [createTool("write_files", {
        type: "object",
        required: ["files"],
        properties: {
          files: { type: "array" },
        },
      })],
    });

    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(decision.kind).toBe("act");
    const repairMessages = generateTurn.mock.calls[1]?.[0]?.messages ?? [];
    const repairPrompt = repairMessages.at(-1)?.content;
    expect(repairPrompt).toContain("invalid tool input");
    expect(repairPrompt).toContain("missing required field 'files'");
    expect(repairPrompt).toContain("call the selected executable tool directly");
  });
});

function createProvider(
  responses: string[],
  structuredOutput: { jsonObject: boolean; jsonSchema: boolean } = { jsonObject: true, jsonSchema: false },
): { provider: LlmProvider; generateTurn: ReturnType<typeof vi.fn> } {
  let index = 0;
  const generateTurn = vi.fn(async () => {
    const content = responses[Math.min(index, responses.length - 1)] ?? "";
    index++;
    return { type: "assistant" as const, content };
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput,
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createNativeToolProvider(
  responses: LlmTurnOutput[],
  structuredOutput: { jsonObject: boolean; jsonSchema: boolean } = { jsonObject: true, jsonSchema: false },
): { provider: LlmProvider; generateTurn: ReturnType<typeof vi.fn> } {
  let index = 0;
  const generateTurn = vi.fn(async () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!response) {
      throw new Error("No queued provider response.");
    }
    return response;
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput,
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function createTool(name: string, inputSchema?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    ...(inputSchema ? { inputSchema } : {}),
    execute: async () => ({
      ok: true,
      content: "",
    }),
  };
}

function createStateView(): AgentStateView {
  return {
    context: {
      timeline: [{
        kind: "user",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        content: "Hii",
        current: true,
      }],
      continuity: {
        mode: "new",
        confidence: 0,
        reasons: ["test"],
      },
      sessionWork: {
        activeContextStartSeq: 1,
        recentActivities: [],
      },
    },
  };
}
