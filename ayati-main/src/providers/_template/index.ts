import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../core/contracts/llm-protocol.js";

const provider: LlmProvider = {
  name: "my-provider", // TODO: change this
  version: "1.0.0",
  capabilities: {
    nativeToolCalling: true,
  },

  start() {
    // initialize SDK client here
  },

  stop() {
    // cleanup here
  },

  async generateTurn(_input: LlmTurnInput): Promise<LlmTurnOutput> {
    // call LLM API here and return either assistant text or tool calls
    return {
      type: "assistant",
      content: "",
    };
  },
};

export default provider;
