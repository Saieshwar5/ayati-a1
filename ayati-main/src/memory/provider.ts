import type {
  AssistantMessageRecordInput,
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  TaskSummaryRecordInput,
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
  recordAssistantFinal(
    _clientId?: string,
    _runId?: string,
    _sessionId?: string,
    _content?: string,
    _metadata?: AssistantMessageRecordInput,
  ): void {
    return;
  },
  recordRunFailure(): void {
    return;
  },
  recordAgentStep(_clientId: string, _input: AgentStepRecordInput): void {
    return;
  },
  recordTaskSummary(_clientId: string, _input: TaskSummaryRecordInput): void {
    return;
  },
  queueTaskSummary(_clientId: string, _input: TaskSummaryRecordInput): void {
    return;
  },
  recordAssistantNotification(): void {
    return;
  },
  getSessionStatus(): null {
    return null;
  },
  updateSessionLifecycle(): void {
    return;
  },
  flushPersistence(): Promise<void> {
    return Promise.resolve();
  },
  getPromptMemoryContext(): PromptMemoryContext {
    return {
      recentExchanges: [],
      recentSystemEvents: [],
      conversationTurns: [],
      personalMemorySnapshot: "",
      personalMemories: [],
      continuity: { mode: "new", confidence: 0, reasons: ["noop memory provider"] },
      recentTaskSummaries: [],
    };
  },
  setStaticTokenBudget(): void {
    return;
  },
};
