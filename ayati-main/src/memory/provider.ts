import type {
  AssistantMessageMetadata,
  AssistantMessageRecordInput,
  SessionMemory,
  SessionStatus,
  MemoryRunHandle,
  SessionInputHandle,
  ToolCallRecordInput,
  ToolCallResultRecordInput,
  AgentStepRecordInput,
  TaskSummaryRecordInput,
  PromptMemoryContext,
} from "./types.js";

const EMPTY_RUN: MemoryRunHandle = {
  sessionId: "noop-session",
  runId: "noop-run",
  triggerSeq: 1,
};

const EMPTY_INPUT: SessionInputHandle = {
  sessionId: "noop-session",
  seq: 1,
};

export const noopSessionMemory: SessionMemory = {
  initialize(): void {
    return;
  },
  shutdown(): void {
    return;
  },
  recordUserMessage(): SessionInputHandle {
    return EMPTY_INPUT;
  },
  recordSystemEvent(): SessionInputHandle {
    return EMPTY_INPUT;
  },
  createWorkRun(): MemoryRunHandle {
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
    _metadata?: AssistantMessageMetadata,
  ): void {
    return;
  },
  recordAssistantMessage(_clientId: string, _input: AssistantMessageRecordInput): void {
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
      sessionEvents: [],
      activeContextStartSeq: 1,
      sessionWork: {
        activeContextStartSeq: 1,
        recentActivities: [],
      },
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
