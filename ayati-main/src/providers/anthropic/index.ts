import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "../../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";

let client: Anthropic | null = null;

interface AnthropicMessageBuild {
  system?: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string | Array<Record<string, unknown>>;
  }>;
}

function toAnthropicPayload(messages: LlmMessage[]): AnthropicMessageBuild {
  const out: AnthropicMessageBuild = {
    messages: [],
  };

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        out.system = out.system ? `${out.system}\n\n${msg.content}` : msg.content;
        break;
      case "user":
      case "assistant":
        out.messages.push({
          role: msg.role,
          content: msg.content,
        });
        break;
      case "assistant_tool_calls": {
        const blocks: Array<Record<string, unknown>> = [];
        if (msg.content && msg.content.trim().length > 0) {
          blocks.push({ type: "text", text: msg.content });
        }
        for (const call of msg.calls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input ?? {},
          });
        }
        out.messages.push({
          role: "assistant",
          content: blocks,
        });
        break;
      }
      case "tool":
        out.messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: msg.content,
            },
          ],
        });
        break;
      default:
        break;
    }
  }

  return out;
}

const provider: LlmProvider = {
  name: "anthropic",
  version: "1.0.0",
  capabilities: {
    nativeToolCalling: true,
  },

  start() {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY environment variable.");
    }
    client = new Anthropic({ apiKey });
  },

  stop() {
    client = null;
  },

  async generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput> {
    if (!client) {
      throw new Error("Anthropic provider not started.");
    }

    const model = process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-5-20250929";
    const payload = toAnthropicPayload(input.messages);

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      ...(payload.system ? { system: payload.system } : {}),
      messages: payload.messages as any,
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema,
            })),
          }
        : {}),
    } as any);

    const calls: LlmToolCall[] = [];
    const textParts: string[] = [];

    for (const block of response.content as unknown as Array<Record<string, unknown>>) {
      if (block.type === "tool_use") {
        calls.push({
          id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
          name: typeof block.name === "string" ? block.name : "unknown_tool",
          input: block.input ?? {},
        });
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      }
    }

    if (calls.length > 0) {
      return {
        type: "tool_calls",
        calls,
        ...(textParts.length > 0 ? { assistantContent: textParts.join("\n").trim() } : {}),
      };
    }

    const reply = textParts.join("\n").trim();
    if (!reply) {
      throw new Error("Empty response from Anthropic.");
    }

    return {
      type: "assistant",
      content: reply,
    };
  },
};

export default provider;
