import type {
  ActiveAttachmentRef,
  ConversationExchange,
  FocusShelfItem,
  PromptTaskSummary,
} from "../../memory/types.js";
import type { LoopState } from "../types.js";

const LIMITS = {
  recentConversation: 5,
  attentionShelf: 5,
  recentTasks: 5,
  activeAttachments: 5,
  textChars: 500,
  summaryChars: 260,
  memoryChars: 1_200,
  learningChars: 1_200,
};

export interface AgentContextPack {
  currentInput: string;
  recentConversation: Array<{
    runId: string;
    user: {
      timestamp: string;
      content: string;
    };
    assistant?: {
      timestamp: string;
      content: string;
      responseKind?: string;
    };
  }>;
  attentionShelf: Array<{
    focusId: string;
    type: string;
    status: string;
    label: string;
    summary: string;
    hints: string[];
    topArtifacts: string[];
    lastTouchedAt: string;
    lastTouchedLabel: string;
    attentionScore: number;
    nextStep?: string;
  }>;
  recentTasks: Array<{
    timestamp: string;
    runId: string;
    runPath: string;
    runStatus: string;
    taskStatus: string;
    objective?: string;
    summary: string;
    progressSummary?: string;
    openWork: string[];
    blockers: string[];
    keyFacts: string[];
    evidence: string[];
    nextAction?: string;
    attachmentNames: string[];
  }>;
  activeAttachments: Array<{
    documentId: string;
    displayName: string;
    kind: string;
    mode: string;
    runId: string;
    runPath: string;
    preparedInputId: string;
    lastUsedAt: string;
  }>;
  previousSessionSummary?: string;
  personalMemorySnapshot?: string;
  activeLearningContext?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  return {
    currentInput: truncate(state.userMessage, LIMITS.textChars),
    attentionShelf: compactAttentionShelf(state.attentionShelf ?? []),
    recentTasks: compactRecentTasks(state.recentTaskSummaries),
    activeAttachments: compactActiveAttachments(state.activeSessionAttachments ?? []),
    ...(state.previousSessionSummary?.trim()
      ? { previousSessionSummary: truncate(state.previousSessionSummary, LIMITS.memoryChars) }
      : {}),
    ...(state.personalMemorySnapshot?.trim()
      ? { personalMemorySnapshot: truncate(state.personalMemorySnapshot, LIMITS.memoryChars) }
      : {}),
    ...(state.activeLearningContext?.trim()
      ? { activeLearningContext: truncate(state.activeLearningContext, LIMITS.learningChars) }
      : {}),
    recentConversation: compactRecentConversation(state.recentExchanges ?? [], state.runId),
  };
}

function compactAttentionShelf(items: FocusShelfItem[]): AgentContextPack["attentionShelf"] {
  return items.slice(0, LIMITS.attentionShelf).map((item) => ({
    focusId: item.focusId,
    type: item.type,
    status: item.status,
    label: truncate(item.label, 120),
    summary: truncate(item.summary, LIMITS.summaryChars),
    hints: item.hints.slice(0, 8).map((hint) => truncate(hint, 80)),
    topArtifacts: item.topArtifacts.slice(0, 5).map((artifact) => truncate(artifact, 160)),
    lastTouchedAt: item.lastTouchedAt,
    lastTouchedLabel: item.lastTouchedLabel,
    attentionScore: Math.round(item.attentionScore * 1000) / 1000,
    ...(item.nextStep?.trim() ? { nextStep: truncate(item.nextStep, LIMITS.summaryChars) } : {}),
  }));
}

function compactRecentConversation(exchanges: ConversationExchange[], currentRunId: string): AgentContextPack["recentConversation"] {
  return exchanges
    .filter((exchange) => exchange.runId !== currentRunId && exchange.assistant !== undefined)
    .slice(-LIMITS.recentConversation)
    .map((exchange) => ({
      runId: exchange.runId,
      user: {
        timestamp: exchange.user.timestamp,
        content: truncate(exchange.user.content, LIMITS.textChars),
      },
      ...(exchange.assistant ? {
        assistant: {
          timestamp: exchange.assistant.timestamp,
          content: truncate(exchange.assistant.content, LIMITS.textChars),
          ...(exchange.assistant.responseKind ? { responseKind: exchange.assistant.responseKind } : {}),
        },
      } : {}),
    }));
}

function compactRecentTasks(tasks: PromptTaskSummary[]): AgentContextPack["recentTasks"] {
  return tasks.slice(0, LIMITS.recentTasks).map((task) => ({
    timestamp: task.timestamp,
    runId: task.runId,
    runPath: task.runPath,
    runStatus: task.runStatus,
    taskStatus: task.taskStatus,
    ...(task.objective?.trim() ? { objective: truncate(task.objective, LIMITS.summaryChars) } : {}),
    summary: truncate(task.summary, LIMITS.summaryChars),
    ...(task.progressSummary?.trim() ? { progressSummary: truncate(task.progressSummary, LIMITS.summaryChars) } : {}),
    openWork: compactList(task.openWork, 5, 180),
    blockers: compactList(task.blockers, 4, 180),
    keyFacts: compactList(task.keyFacts, 6, 180),
    evidence: compactList(task.evidence, 5, 180),
    ...(task.nextAction?.trim() ? { nextAction: truncate(task.nextAction, 180) } : {}),
    attachmentNames: compactList(task.attachmentNames, 6, 120),
  }));
}

function compactActiveAttachments(attachments: ActiveAttachmentRef[]): AgentContextPack["activeAttachments"] {
  return attachments.slice(0, LIMITS.activeAttachments).map((attachment) => ({
    documentId: attachment.documentId,
    displayName: truncate(attachment.displayName, 160),
    kind: attachment.kind,
    mode: attachment.mode,
    runId: attachment.runId,
    runPath: attachment.runPath,
    preparedInputId: attachment.preparedInputId,
    lastUsedAt: attachment.lastUsedAt,
  }));
}

function compactList(values: string[], limit: number, maxChars: number): string[] {
  return values.slice(0, limit).map((value) => truncate(value, maxChars)).filter((value) => value.length > 0);
}

function truncate(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
