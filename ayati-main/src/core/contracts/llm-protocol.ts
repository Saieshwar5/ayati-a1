export interface LlmToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type LlmMessage =
  | {
      role: "system" | "user" | "assistant";
      content: string;
    }
  | {
      role: "assistant_tool_calls";
      calls: LlmToolCall[];
      content?: string;
    }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
    };

export interface LlmTurnInput {
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
}

export type LlmTurnOutput =
  | {
      type: "assistant";
      content: string;
    }
  | {
      type: "tool_calls";
      calls: LlmToolCall[];
      assistantContent?: string;
    };

export interface LlmProviderCapabilities {
  nativeToolCalling: boolean;
}
