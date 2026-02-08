import type {
  LlmProviderCapabilities,
  LlmTurnInput,
  LlmTurnOutput,
} from "./llm-protocol.js";

export interface LlmProvider {
  name: string;
  version: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  capabilities: LlmProviderCapabilities;
  generateTurn(input: LlmTurnInput): Promise<LlmTurnOutput>;
}
