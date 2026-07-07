import type {
  LlmInputTokenCount,
  LlmProviderCapabilities,
  LlmTurnStreamCallbacks,
  LlmTurnInput,
  LlmTurnOutput,
} from "./llm-protocol.js";

export interface LlmProvider {
  name: string;
  version: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  capabilities: LlmProviderCapabilities;
  countInputTokens?(input: LlmTurnInput): Promise<LlmInputTokenCount>;
  generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput>;
  streamTurn?(input: LlmTurnInput, callbacks: LlmTurnStreamCallbacks): Promise<LlmTurnOutput>;
}
