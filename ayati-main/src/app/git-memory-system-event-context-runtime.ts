import type {
  FinalizeGitMemoryTaskRunResult,
  FinalizeGitMemorySessionRunResult,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
  GitContextMemoryState,
  GitMemoryHarnessRunResultForContext,
  GitMemoryMachineContextPack,
  GitMemoryRunId,
  GitMemoryRuntime,
  GitMemorySessionId,
  GitMemorySessionStepRecord,
  GitMemoryStepRecord,
  GitMemoryTaskId,
  RoutedGitMemoryUserTurn,
  StartGitMemorySessionRunResult,
} from "../context-engine/index.js";
import {
  buildGitMemoryHarnessContextFromMemoryState,
} from "../context-engine/index.js";
import type { HarnessContextInput } from "../ivec/harness-context.js";
import { devWarn } from "../shared/index.js";

export interface CreateGitMemorySystemEventContextRuntimeOptions {
  gitMemoryRuntime: GitMemoryRuntime;
}

export interface GitMemorySystemEventContextPrepareInput {
  clientId: string;
  systemMessage: string;
  at: string;
}

export interface GitMemorySystemEventContextPreparedTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface GitMemorySystemEventContextAssistantMessageInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  message: string;
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface GitMemorySystemEventContextCompleteTaskRunInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  result: GitMemoryHarnessRunResultForContext;
  at: string;
  startedAt?: string;
  conversationRefs?: GitMemoryConversationSeqRange[];
  changedFiles?: string[];
  assistantMessage?: string;
  assistantAt?: string;
}

export interface GitMemorySystemEventContextStartSessionRunInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  at: string;
}

export interface GitMemorySystemEventContextFinalizeSessionRunInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  runId: string;
  status: "completed" | "failed" | "blocked" | "needs_user_input";
  summary: string;
  intent?: string;
  routing?: string;
  outcome?: string;
  workPerformed?: string[];
  verification?: string[];
  decisions?: string[];
  assistantResponse?: string;
  at: string;
  blockers?: string[];
  next?: string;
  toolsUsed?: string[];
  toolCallCount?: number;
  changedFiles?: string[];
  newFacts?: string[];
  workState?: unknown;
}

export interface GitMemorySystemEventContextRecordTaskRunStepInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  record: GitMemoryStepRecord;
}

export interface GitMemorySystemEventContextRecordSessionRunStepInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  record: GitMemorySessionStepRecord;
}

export interface GitMemorySystemEventContextRouteTaskTurnInput {
  clientId: string;
  turn: GitMemorySystemEventContextPreparedTurn | null;
  userMessage: string;
  at: string;
  sessionRunId?: GitMemoryRunId;
  title?: string;
  objective?: string;
}

export type GitMemorySystemEventContextRoutedTurn = RoutedGitMemoryUserTurn & {
  harnessContext: HarnessContextInput;
};

export interface GitMemorySystemEventContextRuntime {
  prepareSystemEventTurn(
    input: GitMemorySystemEventContextPrepareInput,
  ): Promise<GitMemorySystemEventContextPreparedTurn>;
  startSessionRun(input: GitMemorySystemEventContextStartSessionRunInput): Promise<StartGitMemorySessionRunResult | null>;
  routeTaskTurn(
    input: GitMemorySystemEventContextRouteTaskTurnInput,
  ): Promise<GitMemorySystemEventContextRoutedTurn | null>;
  finalizeSessionRun(input: GitMemorySystemEventContextFinalizeSessionRunInput): Promise<FinalizeGitMemorySessionRunResult | null>;
  completeTaskRun(input: GitMemorySystemEventContextCompleteTaskRunInput): Promise<FinalizeGitMemoryTaskRunResult | null>;
  recordSessionRunStep(input: GitMemorySystemEventContextRecordSessionRunStepInput): void;
  recordTaskRunStep(input: GitMemorySystemEventContextRecordTaskRunStepInput): void;
  recordAssistantMessage(
    input: GitMemorySystemEventContextAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord | null>;
  buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack>;
}

export function createGitMemorySystemEventContextRuntime(
  options: CreateGitMemorySystemEventContextRuntimeOptions,
): GitMemorySystemEventContextRuntime {
  return new AppGitMemorySystemEventContextRuntime(options.gitMemoryRuntime);
}

class AppGitMemorySystemEventContextRuntime implements GitMemorySystemEventContextRuntime {
  constructor(private readonly gitMemoryRuntime: GitMemoryRuntime) {}

  async prepareSystemEventTurn(
    input: GitMemorySystemEventContextPrepareInput,
  ): Promise<GitMemorySystemEventContextPreparedTurn> {
    const prepared = await this.gitMemoryRuntime.prepareSystemTurn({
      systemMessage: input.systemMessage,
      at: input.at,
    });
    return {
      status: "ready",
      sessionId: prepared.sessionId,
      repoPath: prepared.repoPath,
      initialized: prepared.initialized,
      messageSeq: prepared.systemMessage.seq,
      context: prepared.context,
      memoryState: prepared.memoryState,
    };
  }

  async startSessionRun(
    input: GitMemorySystemEventContextStartSessionRunInput,
  ): Promise<StartGitMemorySessionRunResult | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.startSessionRun({
        sessionId: input.turn.sessionId,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        triggerSeq: input.turn.messageSeq,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event session run start failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async routeTaskTurn(
    input: GitMemorySystemEventContextRouteTaskTurnInput,
  ): Promise<GitMemorySystemEventContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const route = await this.gitMemoryRuntime.routeUserTurn({
        sessionId: input.turn.sessionId,
        userMessage: input.userMessage,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        ...(input.sessionRunId ? { sessionRunId: input.sessionRunId } : {}),
        title: input.title,
        objective: input.objective,
      });
      return {
        ...route,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(route.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event task routing failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async finalizeSessionRun(
    input: GitMemorySystemEventContextFinalizeSessionRunInput,
  ): Promise<FinalizeGitMemorySessionRunResult | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.finalizeSessionRun({
        sessionId: input.turn.sessionId,
        runId: input.runId,
        status: input.status,
        completedAt: input.at,
        triggerSeq: input.turn.messageSeq,
        conversationRefs: [{
          fromSeq: input.turn.messageSeq,
          toSeq: input.turn.messageSeq,
        }],
        summary: input.summary,
        intent: input.intent,
        routing: input.routing,
        outcome: input.outcome,
        workPerformed: input.workPerformed,
        verification: input.verification,
        decisions: input.decisions,
        assistantResponse: input.assistantResponse,
        blockers: input.blockers,
        next: input.next,
        toolsUsed: input.toolsUsed,
        toolCallCount: input.toolCallCount,
        changedFiles: input.changedFiles,
        newFacts: input.newFacts,
        workState: input.workState,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event session run finalize failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async completeTaskRun(
    input: GitMemorySystemEventContextCompleteTaskRunInput,
  ): Promise<FinalizeGitMemoryTaskRunResult | null> {
    if (!input.turn) {
      return null;
    }
    return await this.gitMemoryRuntime.finalizeTaskRun({
      sessionId: input.turn.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      result: input.result,
      conversationRefs: input.conversationRefs ?? [{
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
      }],
      at: input.at,
      startedAt: input.startedAt,
      changedFiles: input.changedFiles,
      assistantMessage: input.assistantMessage,
      assistantAt: input.assistantAt,
    });
  }

  recordTaskRunStep(input: GitMemorySystemEventContextRecordTaskRunStepInput): void {
    if (!input.turn) {
      return;
    }
    this.gitMemoryRuntime.recordTaskRunStep({
      sessionId: input.turn.sessionId,
      record: input.record,
    });
  }

  recordSessionRunStep(input: GitMemorySystemEventContextRecordSessionRunStepInput): void {
    if (!input.turn) {
      return;
    }
    this.gitMemoryRuntime.recordSessionRunStep({
      sessionId: input.turn.sessionId,
      record: input.record,
    });
  }

  async recordAssistantMessage(
    input: GitMemorySystemEventContextAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.recordAssistantMessage({
        sessionId: input.turn.sessionId,
        text: input.message,
        at: input.at,
        taskId: input.taskId,
        runId: input.runId,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory system-event assistant conversation write failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack> {
    return await this.gitMemoryRuntime.buildActiveContext(sessionId);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
