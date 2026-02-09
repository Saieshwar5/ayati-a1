import OpenAI from "openai";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";

let client: OpenAI | null = null;

interface ToolNameMaps {
  canonicalToOpenAi: Map<string, string>;
  openAiToCanonical: Map<string, string>;
}

const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function encodeToolName(name: string): string {
  return `tool_${Buffer.from(name, "utf8").toString("base64url")}`;
}

function toOpenAiToolName(name: string, maps: ToolNameMaps): string {
  const mapped = maps.canonicalToOpenAi.get(name);
  if (mapped) return mapped;
  if (OPENAI_TOOL_NAME_PATTERN.test(name)) return name;
  return encodeToolName(name);
}

function toCanonicalToolName(name: string, maps: ToolNameMaps): string {
  return maps.openAiToCanonical.get(name) ?? name;
}

function buildToolNameMaps(tools?: LlmToolSchema[]): ToolNameMaps {
  const canonicalToOpenAi = new Map<string, string>();
  const openAiToCanonical = new Map<string, string>();

  for (const tool of tools ?? []) {
    let openAiName = OPENAI_TOOL_NAME_PATTERN.test(tool.name)
      ? tool.name
      : encodeToolName(tool.name);
    let suffix = 1;
    while (openAiToCanonical.has(openAiName)) {
      openAiName = `${openAiName}_${suffix}`;
      suffix++;
    }
    canonicalToOpenAi.set(tool.name, openAiName);
    openAiToCanonical.set(openAiName, tool.name);
  }

  return { canonicalToOpenAi, openAiToCanonical };
}

function toOpenAiMessages(
  messages: LlmMessage[],
  maps: ToolNameMaps,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "user":
      case "assistant":
        out.push({ role: msg.role, content: msg.content });
        break;
      case "assistant_tool_calls":
        out.push({
          role: "assistant",
          content: msg.content ?? null,
          tool_calls: msg.calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: toOpenAiToolName(call.name, maps),
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

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const provider: LlmProvider = {
  name: "openai",
  version: "1.0.0",
  capabilities: {
    nativeToolCalling: true,
  },

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

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("OpenAI provider not started.");
    }

    const model = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";
    const nameMaps = buildToolNameMaps(input.tools);
    const messages = toOpenAiMessages(input.messages, nameMaps);

    const response = await client.chat.completions.create({
      model,
      messages,
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({
              type: "function",
              function: {
                name: toOpenAiToolName(tool.name, nameMaps),
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    });

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
      };
    }

    const reply = message.content;
    if (!reply) {
      throw new Error("Empty response from OpenAI.");
    }

    return {
      type: "assistant",
      content: reply,
    };
  },
};

export default provider;
