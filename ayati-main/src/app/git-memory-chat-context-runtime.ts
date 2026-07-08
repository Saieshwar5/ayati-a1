import type {
  FinalizeGitMemoryTaskRunResult,
  FinalizeGitMemorySessionRunResult,
  GitMemoryConversationRecord,
  GitMemoryConversationSeqRange,
  GitContextMemoryState,
  GitMemoryHarnessRunResultForContext,
  GitMemoryMachineContextPack,
  GitMemoryRunId,
  GitMemorySessionAttachmentRecord,
  GitMemorySessionAttachmentsFile,
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

export interface CreateGitMemoryChatContextRuntimeOptions {
  gitMemoryRuntime: GitMemoryRuntime;
}

export interface GitMemoryChatContextPrepareInput {
  clientId: string;
  userMessage: string;
  at: string;
}

export interface GitMemoryChatContextPreparedTurn {
  status: "ready";
  sessionId: GitMemorySessionId;
  repoPath: string;
  initialized: boolean;
  messageSeq: number;
  context: GitMemoryMachineContextPack;
  memoryState: GitContextMemoryState;
}

export interface GitMemoryChatContextAssistantMessageInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  message: string;
  kind?: GitMemoryConversationRecord["kind"];
  at: string;
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
}

export interface GitMemoryChatContextSessionAttachmentsInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  attachments: GitMemorySessionAttachmentRecord[];
  at: string;
}

export interface GitMemoryChatContextCompleteTaskRunInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  result: GitMemoryHarnessRunResultForContext;
  at: string;
  startedAt?: string;
  conversationRefs?: GitMemoryConversationSeqRange[];
  changedFiles?: string[];
  assistantMessage?: string;
  assistantMessageKind?: GitMemoryConversationRecord["kind"];
  assistantAt?: string;
}

export interface GitMemoryChatContextStartSessionRunInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  at: string;
}

export interface GitMemoryChatContextFinalizeSessionRunInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
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
  startedAt?: string;
  blockers?: string[];
  next?: string;
  toolsUsed?: string[];
  toolCallCount?: number;
  changedFiles?: string[];
  newFacts?: string[];
  workState?: unknown;
}

export interface GitMemoryChatContextRecordTaskRunStepInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  record: GitMemoryStepRecord;
}

export interface GitMemoryChatContextRecordSessionRunStepInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  record: GitMemorySessionStepRecord;
}

export interface GitMemoryChatContextRouteTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  userMessage: string;
  at: string;
  sessionRunId?: GitMemoryRunId;
  title?: string;
  objective?: string;
  autoOnly?: boolean;
}

export interface GitMemoryChatContextActivateTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  taskId: GitMemoryTaskId;
  reason: string;
  sessionRunId?: GitMemoryRunId;
  at: string;
}

export interface GitMemoryChatContextCreateTaskTurnInput {
  clientId: string;
  turn: GitMemoryChatContextPreparedTurn | null;
  title: string;
  objective: string;
  reason: string;
  sessionRunId?: GitMemoryRunId;
  at: string;
}

export type GitMemoryChatContextRoutedTurn = RoutedGitMemoryUserTurn & {
  harnessContext: HarnessContextInput;
};

export interface GitMemoryChatContextRuntime {
  prepareUserTurn(input: GitMemoryChatContextPrepareInput): Promise<GitMemoryChatContextPreparedTurn>;
  startSessionRun(input: GitMemoryChatContextStartSessionRunInput): Promise<StartGitMemorySessionRunResult | null>;
  routeTaskTurn(input: GitMemoryChatContextRouteTaskTurnInput): Promise<GitMemoryChatContextRoutedTurn | null>;
  activateTaskTurn(input: GitMemoryChatContextActivateTaskTurnInput): Promise<GitMemoryChatContextRoutedTurn | null>;
  createTaskTurn?(input: GitMemoryChatContextCreateTaskTurnInput): Promise<GitMemoryChatContextRoutedTurn | null>;
  finalizeSessionRun(input: GitMemoryChatContextFinalizeSessionRunInput): Promise<FinalizeGitMemorySessionRunResult | null>;
  completeTaskRun(input: GitMemoryChatContextCompleteTaskRunInput): Promise<FinalizeGitMemoryTaskRunResult | null>;
  recordSessionRunStep(input: GitMemoryChatContextRecordSessionRunStepInput): void;
  recordTaskRunStep(input: GitMemoryChatContextRecordTaskRunStepInput): void;
  recordAssistantMessage(input: GitMemoryChatContextAssistantMessageInput): Promise<GitMemoryConversationRecord | null>;
  recordSessionAttachments(input: GitMemoryChatContextSessionAttachmentsInput): Promise<GitMemorySessionAttachmentsFile | null>;
  buildActiveContext(sessionId: GitMemorySessionId): Promise<GitMemoryMachineContextPack>;
}

export function createGitMemoryChatContextRuntime(
  options: CreateGitMemoryChatContextRuntimeOptions,
): GitMemoryChatContextRuntime {
  return new AppGitMemoryChatContextRuntime(options.gitMemoryRuntime);
}

class AppGitMemoryChatContextRuntime implements GitMemoryChatContextRuntime {
  constructor(private readonly gitMemoryRuntime: GitMemoryRuntime) {}

  async prepareUserTurn(input: GitMemoryChatContextPrepareInput): Promise<GitMemoryChatContextPreparedTurn> {
    const prepared = await this.gitMemoryRuntime.prepareUserTurn({
      userMessage: input.userMessage,
      at: input.at,
    });
    return {
      status: "ready",
      sessionId: prepared.sessionId,
      repoPath: prepared.repoPath,
      initialized: prepared.initialized,
      messageSeq: prepared.userMessage.seq,
      context: prepared.context,
      memoryState: prepared.memoryState,
    };
  }

  async startSessionRun(
    input: GitMemoryChatContextStartSessionRunInput,
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
      devWarn(`[${input.clientId}] git memory session run start failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async routeTaskTurn(
    input: GitMemoryChatContextRouteTaskTurnInput,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const routeInput = {
        sessionId: input.turn.sessionId,
        userMessage: input.userMessage,
        fromSeq: input.turn.messageSeq,
        toSeq: input.turn.messageSeq,
        at: input.at,
        ...(input.sessionRunId ? { sessionRunId: input.sessionRunId } : {}),
        title: input.title,
        objective: input.objective,
      };
      const route = await this.gitMemoryRuntime.continueActiveTurn(routeInput)
        ?? (input.autoOnly ? null : await this.gitMemoryRuntime.routeUserTurn(routeInput));
      if (!route) {
        return null;
      }
      return {
        ...route,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(route.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory task routing failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async activateTaskTurn(
    input: GitMemoryChatContextActivateTaskTurnInput,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const routed = await this.gitMemoryRuntime.activateTaskForTurn({
        sessionId: input.turn.sessionId,
        taskId: input.taskId,
        reason: input.reason,
        ...(input.sessionRunId ? { sessionRunId: input.sessionRunId } : {}),
        at: input.at,
      });
      return {
        ...routed,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(routed.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory active task binding failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async createTaskTurn(
    input: GitMemoryChatContextCreateTaskTurnInput,
  ): Promise<GitMemoryChatContextRoutedTurn | null> {
    if (!input.turn) {
      return null;
    }
    try {
      const routed = await this.gitMemoryRuntime.createTaskForTurn({
        sessionId: input.turn.sessionId,
        title: input.title,
        objective: input.objective,
        reason: input.reason,
        ...(input.sessionRunId ? { sessionRunId: input.sessionRunId } : {}),
        at: input.at,
      });
      return {
        ...routed,
        harnessContext: {
          contextEngine: buildGitMemoryHarnessContextFromMemoryState(routed.memoryState),
        },
      };
    } catch (err) {
      devWarn(`[${input.clientId}] git memory new task target binding failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async finalizeSessionRun(
    input: GitMemoryChatContextFinalizeSessionRunInput,
  ): Promise<FinalizeGitMemorySessionRunResult | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.finalizeSessionRun({
        sessionId: input.turn.sessionId,
        runId: input.runId,
        status: input.status,
        startedAt: input.startedAt,
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
      devWarn(`[${input.clientId}] git memory session run finalize failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async completeTaskRun(
    input: GitMemoryChatContextCompleteTaskRunInput,
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
      assistantMessageKind: input.assistantMessageKind,
      assistantAt: input.assistantAt,
    });
  }

  recordSessionRunStep(input: GitMemoryChatContextRecordSessionRunStepInput): void {
    if (!input.turn) {
      return;
    }
    this.gitMemoryRuntime.recordSessionRunStep({
      sessionId: input.turn.sessionId,
      record: input.record,
    });
  }

  recordTaskRunStep(input: GitMemoryChatContextRecordTaskRunStepInput): void {
    if (!input.turn) {
      return;
    }
    this.gitMemoryRuntime.recordTaskRunStep({
      sessionId: input.turn.sessionId,
      record: input.record,
    });
  }

  async recordAssistantMessage(
    input: GitMemoryChatContextAssistantMessageInput,
  ): Promise<GitMemoryConversationRecord | null> {
    if (!input.turn) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.recordAssistantMessage({
        sessionId: input.turn.sessionId,
        text: input.message,
        kind: input.kind,
        at: input.at,
        taskId: input.taskId,
        runId: input.runId,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory assistant conversation write failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async recordSessionAttachments(
    input: GitMemoryChatContextSessionAttachmentsInput,
  ): Promise<GitMemorySessionAttachmentsFile | null> {
    if (!input.turn || input.attachments.length === 0) {
      return null;
    }
    try {
      return await this.gitMemoryRuntime.recordSessionAttachments({
        sessionId: input.turn.sessionId,
        attachments: input.attachments,
        at: input.at,
      });
    } catch (err) {
      devWarn(`[${input.clientId}] git memory session attachment write failed: ${errorMessage(err)}`);
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
