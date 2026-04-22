import type {
  AssistantMessageRecordInput,
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  RunLedgerRecordInput,
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
  recordRunLedger(_clientId: string, _input: RunLedgerRecordInput): void {
    return;
  },
  recordActiveAttachments(): void {
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
      conversationTurns: [],
      previousSessionSummary: "",
      recentTaskSummaries: [],
      activeAttachments: [],
      recentSystemActivity: [],
    };
  },
  getActiveAttachmentRecords(): [] {
    return [];
  },
  setStaticTokenBudget(): void {
    return;
  },
};
