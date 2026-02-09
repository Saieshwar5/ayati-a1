export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ConversationWindowConfig {
  maxTurns: number;
  maxChars: number;
}

export interface ConversationMemoryProvider {
  getRecentTurns(clientId?: string): Promise<ConversationTurn[]>;
}
