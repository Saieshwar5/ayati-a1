import OpenAI from "openai";
import type { LlmProvider } from "../../core/contracts/provider.js";
import { getModelForProvider } from "../../config/llm-runtime-config.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmInputTokenCount,
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { toOpenAiResponseFormat } from "../shared/openai-response-format.js";
import { toOpenAiCompatibleContent } from "../shared/multimodal.js";
import {
  compileResponseFormatForProvider,
  getProviderCapabilities,
} from "../shared/provider-profiles.js";
import {
  buildToolNameMapsForProvider,
  toCanonicalToolName,
  toProviderToolName,
  type ToolNameMaps,
} from "../shared/tool-name-mapping.js";

let client: OpenAI | null = null;

const DEFAULT_FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_FIREWORKS_REASONING_EFFORT = "medium";
const FIREWORKS_REASONING_EFFORTS = new Set(["low", "medium", "high"]);

async function toFireworksMessages(
  messages: LlmMessage[],
  maps: ToolNameMaps,
): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "assistant":
        out.push({ role: msg.role, content: msg.content });
        break;
      case "user":
        out.push({
          role: "user",
          content: await toOpenAiCompatibleContent(msg.content),
        } as OpenAI.ChatCompletionUserMessageParam);
        break;
      case "assistant_tool_calls":
        out.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: toProviderToolName(call.name, maps),
              arguments: JSON.stringify(call.input ?? {}),
            },
          })),
        } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam);
        break;
      case "tool":
        out.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        } as OpenAI.Chat.Completions.ChatCompletionToolMessageParam);
        break;
      default:
        break;
    }
  }

  return out;
}

function toFireworksResponseTools(
  tools: LlmToolSchema[] | undefined,
  maps: ToolNameMaps,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    type: "function",
    name: toProviderToolName(tool.name, maps),
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function usesMiniMaxReasoning(model: string): boolean {
  return /minimax-m2/i.test(model);
}

function getReasoningEffort(): "low" | "medium" | "high" {
  const configured = process.env["FIREWORKS_REASONING_EFFORT"] ?? DEFAULT_FIREWORKS_REASONING_EFFORT;

  if (!FIREWORKS_REASONING_EFFORTS.has(configured)) {
    throw new Error(
      `Invalid FIREWORKS_REASONING_EFFORT "${configured}". Expected one of: low, medium, high.`,
    );
  }

  return configured as "low" | "medium" | "high";
}

function buildEmptyResponseMessage(response: {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    } | null;
    finish_reason?: unknown;
  }> | null;
}): string {
  const firstChoice = response.choices?.[0];
  if (!firstChoice) {
    return "Empty response from Fireworks: no choices were returned.";
  }

  const finishReason = typeof firstChoice.finish_reason === "string"
    ? ` finish_reason=${firstChoice.finish_reason}.`
    : "";
  const message = firstChoice.message;
  if (!message) {
    return `Empty response from Fireworks: first choice did not include a message.${finishReason}`;
  }

  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasStringContent = typeof message.content === "string" && message.content.trim().length > 0;
  if (!hasStringContent && !hasToolCalls) {
    return `Empty response from Fireworks: first message had no text content and no tool calls.${finishReason}`;
  }

  return `Empty response from Fireworks: no usable assistant payload was returned.${finishReason}`;
}

const provider: LlmProvider = {
  name: "fireworks",
  version: "1.0.0",
  capabilities: getProviderCapabilities("fireworks"),

  start() {
    const apiKey = process.env["FIREWORKS_API_KEY"];
    if (!apiKey) {
      throw new Error("Missing FIREWORKS_API_KEY environment variable.");
    }

    const baseURL = process.env["FIREWORKS_BASE_URL"] ?? DEFAULT_FIREWORKS_BASE_URL;

    client = new OpenAI({
      apiKey,
      baseURL,
    });
  },

  stop() {
    client = null;
  },

  async countInputTokens(input: LlmTurnInput): Promise<LlmInputTokenCount> {
    if (!client) {
      throw new Error("Fireworks provider not started.");
    }

    const model = getModelForProvider("fireworks");
    const estimate = estimateTurnInputTokens(input);

    return {
      provider: "fireworks",
      model,
      inputTokens: estimate.totalTokens,
      exact: false,
    };
  },

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("Fireworks provider not started.");
    }

    const model = getModelForProvider("fireworks");
    const nameMaps = buildToolNameMapsForProvider(provider.name, input.tools);
    const messages = await toFireworksMessages(input.messages, nameMaps);
    const responseTools = toFireworksResponseTools(input.tools, nameMaps);
    const responseFormat = responseTools
      ? undefined
      : toOpenAiResponseFormat(
          compileResponseFormatForProvider(provider.name, provider.capabilities, input.responseFormat),
        );

    const request: Record<string, unknown> = {
      model,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(responseTools
        ? {
            tools: responseTools.map((tool) => ({
              type: "function",
              function: {
                name: tool["name"] as string,
                description: (tool["description"] as string | undefined) ?? undefined,
                parameters: (tool["parameters"] as Record<string, unknown>) ?? {},
              },
            })),
            tool_choice: "auto",
          }
        : {}),
      ...(usesMiniMaxReasoning(model) ? { reasoning_effort: getReasoningEffort() } : {}),
    };

    const response = await client.chat.completions.create(request as any);

    const message = response.choices?.[0]?.message;
    if (!message) {
      throw new Error(buildEmptyResponseMessage(response));
    }

    const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map<LlmToolCall>((call) => {
      const fn =
        "function" in call
          ? (call.function as { name?: string; arguments?: string } | undefined)
          : undefined;
      return {
        id: call.id ?? crypto.randomUUID(),
        name: toCanonicalToolName(fn?.name ?? "unknown_tool", nameMaps),
        input: parseToolArguments(fn?.arguments ?? "{}"),
      };
    });

    if (calls.length > 0) {
      return {
        type: "tool_calls",
        calls,
        ...(typeof message.content === "string" ? { assistantContent: message.content } : {}),
      };
    }

    const reply = typeof message.content === "string" ? message.content : "";
    if (reply.trim().length === 0) {
      throw new Error(buildEmptyResponseMessage(response));
    }

    return {
      type: "assistant",
      content: reply,
    };
  },
};

export default provider;
