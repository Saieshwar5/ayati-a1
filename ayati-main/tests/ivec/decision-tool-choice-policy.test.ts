import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type {
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../src/core/contracts/llm-protocol.js";
import { buildCoreCapsule } from "../../src/ivec/agent-runner/core-capsule.js";
import { callAgentDecision } from "../../src/ivec/agent-runner/decision.js";
import {
  resolveDecisionToolChoicePolicy,
} from "../../src/ivec/agent-runner/decision-tool-choice-policy.js";
import type { AgentStateView } from "../../src/ivec/agent-runner/state-view.js";
import type {
  AgentFeedbackEventInput,
  AgentFeedbackLedger,
} from "../../src/ivec/feedback-ledger.js";

describe("decision tool-choice policy", () => {
  it("allows direct assistant text only when normal_reply is graph-legal", () => {
    expect(resolveDecisionToolChoicePolicy({
      stateView: stateView("ENTRY", ["normal_reply", "observe.locate"]),
      nativeTools: [nativeTool("decision_enter_observe_locate")],
    })).toMatchObject({
      directAssistantResponseAllowed: true,
      nativeToolCallRequired: false,
      toolChoice: "auto",
    });

    expect(resolveDecisionToolChoicePolicy({
      stateView: stateView("observe.locate", ["observe.locate", "resolve", "validation", "stop"]),
      nativeTools: [nativeTool("decision_resolve_create")],
    })).toMatchObject({
      directAssistantResponseAllowed: false,
      nativeToolCallRequired: true,
      toolChoice: "required",
    });

    expect(resolveDecisionToolChoicePolicy({
      stateView: stateView("validation", ["normal_reply"]),
      nativeTools: [nativeTool("decision_enter_observe_locate")],
    })).toMatchObject({
      directAssistantResponseAllowed: true,
      nativeToolCallRequired: false,
      toolChoice: "auto",
    });
  });

  it("pins a known repair target only when that native tool remains available", () => {
    expect(resolveDecisionToolChoicePolicy({
      stateView: stateView("observe.locate", ["resolve", "validation", "stop"]),
      nativeTools: [nativeTool("decision_resolve_create")],
      preferredNativeToolName: "decision_resolve_create",
    }).toolChoice).toEqual({ name: "decision_resolve_create" });

    expect(resolveDecisionToolChoicePolicy({
      stateView: stateView("observe.locate", ["resolve", "validation", "stop"]),
      nativeTools: [nativeTool("decision_enter_validation")],
      preferredNativeToolName: "decision_resolve_create",
    }).toolChoice).toBe("required");
  });

  it("keeps ENTRY conversational replies on automatic tool choice", async () => {
    const { provider, generateTurn } = providerWithResponses([{
      type: "assistant",
      content: "Hello!",
    }]);

    const decision = await callAgentDecision({
      provider,
      stateView: stateView("ENTRY", ["normal_reply", "observe.locate", "resolve"]),
      toolDefinitions: [],
    });

    expect(decision).toEqual({
      kind: "reply",
      status: "completed",
      message: "Hello!",
    });
    expect(generateTurn.mock.calls[0]?.[0]?.toolChoice).toBe("auto");
  });

  it("requires a native call in an active graph and repairs assistant text before parsing it as a reply", async () => {
    const malformedBareArguments = [
      "{",
      "  \"purpose\": \"Create the requested balcony note.\",",
      "  \"capabilities\": [\"file:write\"],",
      "  \"workspaceTargets\": [{\"kind\":\"file\",\"relativePath\":\"balcony-herbs.md\"}],",
      "  \"binding\": {",
      "    \"title\": \"Balcony Herb Garden Note\",",
      "    \"objective\": \"Create and maintain the balcony herb note.\",",
      "    \"initialRequest\": {",
      "      \"title\": \"Create the balcony herb note\",",
      "      \"request\": \"Create balcony-herbs.md.\",",
      "      \"acceptance\": [\"The requested note exists.\"],",
      "      \"constraints\": []",
      "    }",
      "  }",
      "}",
      "}",
    ].join("\n");
    const { provider, generateTurn } = providerWithResponses([
      {
        type: "assistant",
        content: malformedBareArguments,
      },
      {
        type: "tool_calls",
        calls: [{
          id: "call-create",
          name: "decision_resolve_create",
          input: {
            purpose: "Create the requested balcony note.",
            capabilities: ["file:write"],
            workspaceTargets: [{
              kind: "file",
              relativePath: "balcony-herbs.md",
            }],
            binding: {
              title: "Balcony Herb Garden Note",
              objective: "Create and maintain the balcony herb note.",
              initialRequest: {
                title: "Create the balcony herb note",
                request: "Create balcony-herbs.md.",
                acceptance: ["The requested note exists."],
                constraints: [],
              },
            },
          },
        }],
      },
    ]);
    const feedback = feedbackLedger();

    const decision = await callAgentDecision({
      provider,
      stateView: stateView(
        "observe.locate",
        ["observe.locate", "observe.investigate", "resolve", "validation", "stop"],
      ),
      toolDefinitions: [],
      feedbackLedger: feedback.ledger,
      feedbackContext: {
        clientId: "local",
        sessionId: "S-test",
        seq: 1,
        runId: "RUN-1",
      },
    });

    expect(decision).toMatchObject({
      kind: "transition_mode",
      request: {
        to: "resolve",
        capabilities: ["file:write"],
        workspaceTargets: [{
          kind: "file",
          relativePath: "balcony-herbs.md",
        }],
        binding: {
          kind: "create",
          title: "Balcony Herb Garden Note",
        },
      },
    });
    expect(generateTurn).toHaveBeenCalledTimes(2);
    expect(generateTurn.mock.calls[0]?.[0]?.toolChoice).toBe("required");
    expect(generateTurn.mock.calls[1]?.[0]?.toolChoice).toBe("required");
    const resolveCreate = generateTurn.mock.calls[0]?.[0]?.tools
      ?.find((tool) => tool.name === "decision_resolve_create");
    expect(resolveCreate?.inputSchema["properties"]).not.toHaveProperty("references");
    const repairPrompt = generateTurn.mock.calls[1]?.[0]?.messages.at(-1)?.content ?? "";
    expect(repairPrompt).toContain(
      "The current graph state requires one native tool call",
    );
    expect(repairPrompt).toContain(
      "Do not print tool names or arguments as assistant text",
    );
    expect(feedback.events.find(
      (event) => event.event === "assistant_text_tool_call",
    )?.data).toMatchObject({
      repair: {
        code: "R_ASSISTANT_TEXT_TOOL_CALL",
        operatorDetails: {
          nativeToolCallRequired: true,
        },
      },
    });
    expect(feedback.events.some((event) => event.event === "direct_reply")).toBe(false);
  });
});

function stateView(
  active: "ENTRY" | "observe.locate" | "validation",
  allowedNext: Array<
    | "normal_reply"
    | "stop"
    | "observe.locate"
    | "observe.investigate"
    | "resolve"
    | "validation"
  >,
): AgentStateView {
  return {
    context: {
      core: buildCoreCapsule({
        revision: "context:test",
        runId: "RUN-1",
        timeline: [{
          kind: "user",
          seq: 1,
          timestamp: new Date(0).toISOString(),
          content: "Create balcony-herbs.md in my workspace.",
          current: true,
        }],
      }),
      hot: {
        available: [],
        loaded: [],
        budget: {
          maxMountedTokens: 8_000,
          mountedTokens: 0,
        },
      },
      run: {
        workspaceRoot: "/tmp/workspace",
        mode: {
          active,
          revision: active === "ENTRY" ? 0 : 1,
          capabilities: active === "observe.locate"
            ? ["workstream:search"]
            : active === "validation"
              ? ["task:validation"]
              : [],
          targets: active === "observe.locate" ? ["balcony herbs"] : [],
          allowedNext,
        },
      },
    },
  };
}

function nativeTool(name: string): LlmToolSchema {
  return {
    name,
    description: `${name} test control`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}

function providerWithResponses(responses: LlmTurnOutput[]): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const generateTurn = vi.fn(async (_input: LlmTurnInput): Promise<LlmTurnOutput> => {
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    if (!response) throw new Error("No provider response configured.");
    return response;
  });
  return {
    provider: {
      name: "fake-provider",
      version: "test-model",
      capabilities: {
        nativeToolCalling: true,
        structuredOutput: {
          jsonObject: true,
          jsonSchema: false,
        },
      },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function feedbackLedger(): {
  ledger: AgentFeedbackLedger;
  events: AgentFeedbackEventInput[];
} {
  const events: AgentFeedbackEventInput[] = [];
  return {
    events,
    ledger: {
      enabled: true,
      record(event) {
        events.push(event);
      },
      async flush() {},
      async close() {},
    },
  };
}
