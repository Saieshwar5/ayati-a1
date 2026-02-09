import type {
  SessionMemory,
  MemoryRunHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  PromptMemoryContext,
} from "./types.js";

const EMPTY_RUN: MemoryRunHandle = {
  sessionId: "noop-session",
  runId: "noop-run",
};

export const noopSessionMemory: SessionMemory = {
  initialize(): void {
    return;
  },
  shutdown(): void {
    return;
  },
  beginRun(): MemoryRunHandle {
    return EMPTY_RUN;
  },
  recordToolCall(_clientId: string, _input: ToolCallRecordInput): void {
    return;
  },
  recordToolResult(_clientId: string, _input: ToolCallResultRecordInput): void {
    return;
  },
  recordAssistantFinal(): void {
    return;
  },
  recordRunFailure(): void {
    return;
  },
  getPromptMemoryContext(): PromptMemoryContext {
    return {
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
    };
  },
};
