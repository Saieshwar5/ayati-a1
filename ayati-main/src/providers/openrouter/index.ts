import OpenAI from "openai";
import type { LlmProvider } from "../../core/contracts/provider.js";
import { ProviderEmptyResponseError } from "../../core/contracts/provider-errors.js";
import { getModelForProvider } from "../../config/llm-runtime-config.js";
import type {
  LlmMessage,
  LlmToolChoice,
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

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function emptyOpenRouterResponseError(
  model: string,
  response: unknown,
): ProviderEmptyResponseError {
  const responseRecord = isRecord(response) ? response : {};
  const choices = Array.isArray(responseRecord["choices"]) ? responseRecord["choices"] : [];
  const firstChoice = isRecord(choices[0]) ? choices[0] : {};
  const firstMessage = isRecord(firstChoice["message"]) ? firstChoice["message"] : undefined;
  const finishReason = typeof firstChoice["finish_reason"] === "string" ? firstChoice["finish_reason"] : undefined;

  return new ProviderEmptyResponseError("Empty response from OpenRouter.", {
    provider: "openrouter",
    model,
    choiceCount: choices.length,
    responseKeys: Object.keys(responseRecord),
    ...(finishReason ? { finishReason } : {}),
    hasMessage: Boolean(firstMessage),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function toOpenRouterMessages(
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

function toOpenRouterResponseTools(
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

function toOpenRouterToolChoice(
  choice: LlmToolChoice | undefined,
  maps: ToolNameMaps,
): "auto" | "required" | { type: "function"; function: { name: string } } | undefined {
  if (!choice) return undefined;
  if (choice === "auto" || choice === "required") return choice;
  return {
    type: "function",
    function: {
      name: toProviderToolName(choice.name, maps),
    },
  };
}

const provider: LlmProvider = {
  name: "openrouter",
  version: "1.0.0",
  capabilities: getProviderCapabilities("openrouter"),

  start() {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    if (!apiKey) {
      throw new Error("Missing OPENROUTER_API_KEY environment variable.");
    }

    const baseURL = process.env["OPENROUTER_BASE_URL"] ?? DEFAULT_OPENROUTER_BASE_URL;
    const siteUrl = process.env["OPENROUTER_SITE_URL"];
    const appName = process.env["OPENROUTER_APP_NAME"];

    client = new OpenAI({
      apiKey,
      baseURL,
      ...(siteUrl || appName
        ? {
            defaultHeaders: {
              ...(siteUrl ? { "HTTP-Referer": siteUrl } : {}),
              ...(appName ? { "X-Title": appName } : {}),
            },
          }
        : {}),
    });
  },

  stop() {
    client = null;
  },

  async countInputTokens(input: LlmTurnInput): Promise<LlmInputTokenCount> {
    if (!client) {
      throw new Error("OpenRouter provider not started.");
    }

    const model = getModelForProvider("openrouter");
    const estimate = estimateTurnInputTokens(input);

    return {
      provider: "openrouter",
      model,
      inputTokens: estimate.totalTokens,
      exact: false,
    };
  },

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("OpenRouter provider not started.");
    }

    const model = getModelForProvider("openrouter");
    const nameMaps = buildToolNameMapsForProvider(provider.name, input.tools);
    const messages = await toOpenRouterMessages(input.messages, nameMaps);
    const responseTools = toOpenRouterResponseTools(input.tools, nameMaps);
    const toolChoice = toOpenRouterToolChoice(input.toolChoice, nameMaps);
    const responseFormat = toOpenAiResponseFormat(
      compileResponseFormatForProvider(provider.name, provider.capabilities, input.responseFormat),
    );

    const response = await client.chat.completions.create({
      model,
      messages,
      ...(responseFormat ? { response_format: responseFormat as any } : {}),
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
            tool_choice: toolChoice ?? "auto",
            ...(typeof input.parallelToolCalls === "boolean" ? { parallel_tool_calls: input.parallelToolCalls } : {}),
          }
        : {}),
    });

    const choices = Array.isArray(response.choices) ? response.choices : [];
    const message = choices[0]?.message;
    if (!message) {
      throw emptyOpenRouterResponseError(model, response);
    }

    const calls = (message.tool_calls ?? []).map<LlmToolCall>((call) => {
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

    const reply = message.content;
    if (!reply) {
      throw emptyOpenRouterResponseError(model, response);
    }

    return {
      type: "assistant",
      content: reply,
    };
  },
};

export default provider;
