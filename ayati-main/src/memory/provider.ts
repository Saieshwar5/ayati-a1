import type { ConversationMemoryProvider, ConversationTurn } from "./types.js";

export const noopConversationMemoryProvider: ConversationMemoryProvider = {
  async getRecentTurns(): Promise<ConversationTurn[]> {
    return [];
  },
};
