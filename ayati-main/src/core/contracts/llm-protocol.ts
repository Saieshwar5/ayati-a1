export interface LlmToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmToolChoice = "auto" | "required" | { name: string };

export type LlmResponseFormat =
  | {
      type: "json_object";
    }
  | {
      type: "json_schema";
      name: string;
      schema: Record<string, unknown>;
      strict?: boolean;
    };

export interface LlmToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface LlmTextContentPart {
  type: "text";
  text: string;
}

export interface LlmImageContentPart {
  type: "image";
  imagePath: string;
  mimeType: string;
  name?: string;
}

export type LlmUserContentPart = LlmTextContentPart | LlmImageContentPart;
export type LlmUserContent = string | LlmUserContentPart[];

export type LlmMessage =
  | {
      role: "system" | "assistant";
      content: string;
    }
  | {
      role: "user";
      content: LlmUserContent;
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
  toolChoice?: LlmToolChoice;
  parallelToolCalls?: boolean;
  responseFormat?: LlmResponseFormat;
}

export interface LlmInputTokenCount {
  provider: string;
  model: string;
  inputTokens: number;
  exact: boolean;
}

export interface LlmTokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  exact: boolean;
}

export interface LlmCostEstimate {
  currency: "USD";
  inputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  pricingSource: string;
}

export type LlmTurnOutput =
  | {
      type: "assistant";
      content: string;
      usage?: LlmTokenUsage;
      cost?: LlmCostEstimate;
    }
  | {
      type: "tool_calls";
      calls: LlmToolCall[];
      assistantContent?: string;
      usage?: LlmTokenUsage;
      cost?: LlmCostEstimate;
    };

export interface LlmProviderCapabilities {
  nativeToolCalling: boolean;
  imageInput?: boolean;
  structuredOutput?: {
    jsonObject: boolean;
    jsonSchema: boolean;
  };
}
