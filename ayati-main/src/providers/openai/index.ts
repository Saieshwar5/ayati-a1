import OpenAI from "openai";
import type { LlmProvider } from "../../core/contracts/provider.js";
import { getModelForProvider } from "../../config/llm-runtime-config.js";
import type {
  LlmMessage,
  LlmToolChoice,
  LlmToolCall,
  LlmInputTokenCount,
  LlmTokenUsage,
  LlmTurnStreamCallbacks,
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";
import { estimateTurnInputTokens } from "../../prompt/token-estimator.js";
import { toOpenAiResponseFormat } from "../shared/openai-response-format.js";
import { hasImageInput, toOpenAiCompatibleContent } from "../shared/multimodal.js";
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
import { readOpenAiCompatibleUsage } from "../shared/token-usage.js";
import {
  captureProviderNativePayload,
  captureProviderNativeResponse,
  isLiveEvaluationEnabled,
} from "../../evaluation/capture-runtime.js";

let client: OpenAI | null = null;

async function toOpenAiMessages(
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

function toOpenAiCountInputItems(
  messages: LlmMessage[],
  maps: ToolNameMaps,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "user":
      case "assistant":
        out.push({
          type: "message",
          role: msg.role,
          content: msg.content,
        });
        break;
      case "assistant_tool_calls":
        if (msg.content && msg.content.trim().length > 0) {
          out.push({
            type: "message",
            role: "assistant",
            content: msg.content,
          });
        }
        for (const call of msg.calls) {
          out.push({
            type: "function_call",
            call_id: call.id,
            name: toProviderToolName(call.name, maps),
            arguments: JSON.stringify(call.input ?? {}),
          });
        }
        break;
      case "tool":
        out.push({
          type: "function_call_output",
          call_id: msg.toolCallId,
          output: msg.content,
        });
        break;
      default:
        break;
    }
  }

  return out;
}

function toOpenAiResponseTools(
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

function toOpenAiToolChoice(
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
  name: "openai",
  version: "1.0.0",
  capabilities: getProviderCapabilities("openai"),

  start() {
    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY environment variable.");
    }
    client = new OpenAI({ apiKey });
  },

  stop() {
    client = null;
  },

  async countInputTokens(input: LlmTurnInput): Promise<LlmInputTokenCount> {
    if (!client) {
      throw new Error("OpenAI provider not started.");
    }

    const model = getModelForProvider("openai");
    if (hasImageInput(input.messages)) {
      const estimate = estimateTurnInputTokens(input);
      return {
        provider: "openai",
        model,
        inputTokens: estimate.totalTokens,
        exact: false,
      };
    }

    const nameMaps = buildToolNameMapsForProvider(provider.name, input.tools);
    const inputItems = toOpenAiCountInputItems(input.messages, nameMaps);
    const tools = toOpenAiResponseTools(input.tools, nameMaps);

    const countRequest = {
      model,
      input: inputItems as any,
      ...(tools ? { tools: tools as any } : {}),
    };
    captureProviderNativePayload({ provider: "openai", operation: "countInputTokens", payload: countRequest });
    const count = await client.responses.inputTokens.count(countRequest);
    captureProviderNativeResponse({ provider: "openai", operation: "countInputTokens", response: count });

    return {
      provider: "openai",
      model,
      inputTokens: count.input_tokens,
      exact: false,
    };
  },

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("OpenAI provider not started.");
    }

    const model = getModelForProvider("openai");
    const nameMaps = buildToolNameMapsForProvider(provider.name, input.tools);
    const messages = await toOpenAiMessages(input.messages, nameMaps);
    const responseTools = toOpenAiResponseTools(input.tools, nameMaps);
    const toolChoice = toOpenAiToolChoice(input.toolChoice, nameMaps);
    const responseFormat = toOpenAiResponseFormat(
      compileResponseFormatForProvider(provider.name, provider.capabilities, input.responseFormat),
    );

    const request = {
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
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    captureProviderNativePayload({ provider: "openai", operation: "generateTurn", payload: request });
    const response = await client.chat.completions.create(request);
    captureProviderNativeResponse({ provider: "openai", operation: "generateTurn", response });
    const usage = readOpenAiCompatibleUsage("openai", model, response);

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("Empty response from OpenAI.");
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
        ...(usage ? { usage } : {}),
      };
    }

    const reply = message.content;
    if (!reply) {
      throw new Error("Empty response from OpenAI.");
    }

    return {
      type: "assistant",
      content: reply,
      ...(usage ? { usage } : {}),
    };
  },

  async streamTurn(input: LlmTurnInput, callbacks: LlmTurnStreamCallbacks): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("OpenAI provider not started.");
    }

    const model = getModelForProvider("openai");
    const nameMaps = buildToolNameMapsForProvider(provider.name, input.tools);
    const messages = await toOpenAiMessages(input.messages, nameMaps);
    const responseTools = toOpenAiResponseTools(input.tools, nameMaps);
    const toolChoice = toOpenAiToolChoice(input.toolChoice, nameMaps);
    const responseFormat = toOpenAiResponseFormat(
      compileResponseFormatForProvider(provider.name, provider.capabilities, input.responseFormat),
    );

    const request = {
      model,
      messages,
      stream: true,
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
    };
    captureProviderNativePayload({ provider: "openai", operation: "streamTurn", payload: request });
    const stream = await client.chat.completions.create(request as any);

    const textParts: string[] = [];
    const nativeChunks: unknown[] | undefined = isLiveEvaluationEnabled() ? [] : undefined;
    let usage: LlmTokenUsage | undefined;
    const toolCalls = new Map<number, {
      id?: string;
      name?: string;
      arguments: string;
    }>();

    try {
      for await (const chunk of stream as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
        nativeChunks?.push(chunk);
        usage = readOpenAiCompatibleUsage("openai", model, chunk) ?? usage;
        const delta = chunk.choices[0]?.delta;
        const content = delta?.content;
        if (typeof content === "string" && content.length > 0) {
          textParts.push(content);
          callbacks.onTextDelta?.(content);
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = typeof call.index === "number" ? call.index : toolCalls.size;
          const existing = toolCalls.get(index) ?? { arguments: "" };
          const fn = call.function;
          toolCalls.set(index, {
            id: call.id ?? existing.id,
            name: fn?.name ?? existing.name,
            arguments: `${existing.arguments}${fn?.arguments ?? ""}`,
          });
        }
      }
    } finally {
      if (nativeChunks) captureProviderNativeResponse({ provider: "openai", operation: "streamTurn", response: { chunks: nativeChunks } });
    }

    if (toolCalls.size > 0) {
      const calls = [...toolCalls.values()].map<LlmToolCall>((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: toCanonicalToolName(call.name ?? "unknown_tool", nameMaps),
        input: parseToolArguments(call.arguments || "{}"),
      }));
      return {
        type: "tool_calls",
        calls,
        ...(textParts.length > 0 ? { assistantContent: textParts.join("") } : {}),
        ...(usage ? { usage } : {}),
      };
    }

    const reply = textParts.join("");
    if (!reply) {
      throw new Error("Empty response from OpenAI.");
    }

    return {
      type: "assistant",
      content: reply,
      ...(usage ? { usage } : {}),
    };
  },
};

export default provider;
