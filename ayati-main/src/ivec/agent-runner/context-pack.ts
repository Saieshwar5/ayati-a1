import type {
  ActiveAttachmentRef,
  ConversationExchange,
  FocusShelfItem,
} from "../../memory/types.js";
import type { LoopState } from "../types.js";

const LIMITS = {
  recentConversation: 5,
  activeFocus: 3,
  sessionFocusCards: 5,
  attentionShelf: 5,
  activeAttachments: 5,
  textChars: 500,
  summaryChars: 260,
  memoryChars: 1_200,
  learningChars: 1_200,
};

type ContextFocusItem = {
  focusId: string;
  scope: string;
  type: string;
  status: string;
  label: string;
  summary: string;
  hints: string[];
  topArtifacts: string[];
  openWork: string[];
  lastTouchedAt: string;
  lastTouchedLabel: string;
  attentionScore: number;
  nextStep?: string;
  activatedReason?: string;
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
  activeFocus: ContextFocusItem[];
  sessionFocusCards: ContextFocusItem[];
  attentionShelf: ContextFocusItem[];
  activeAttachments: Array<{
    attachmentKind: string;
    assetId?: string;
    documentId?: string;
    fileId?: string;
    directoryId?: string;
    displayName: string;
    kind: string;
    mode?: string;
    capabilities?: string[];
    runId: string;
    runPath: string;
    preparedInputId?: string;
    path?: string;
    lastUsedAt: string;
  }>;
  previousSessionSummary?: string;
  personalMemorySnapshot?: string;
  activeLearningContext?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  return {
    currentInput: truncate(state.userMessage, LIMITS.textChars),
    activeFocus: compactFocusShelf(state.activeFocus ?? [], LIMITS.activeFocus),
    sessionFocusCards: compactFocusShelf(state.sessionFocusCards ?? [], LIMITS.sessionFocusCards),
    attentionShelf: compactAttentionShelf(state.attentionShelf ?? []),
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

function compactAttentionShelf(items: FocusShelfItem[]): ContextFocusItem[] {
  return compactFocusShelf(items, LIMITS.attentionShelf);
}

function compactFocusShelf(items: FocusShelfItem[], limit: number): ContextFocusItem[] {
  return items.slice(0, limit).map((item) => ({
    focusId: item.focusId,
    scope: item.scope,
    type: item.type,
    status: item.status,
    label: truncate(item.label, 120),
    summary: truncate(item.summary, LIMITS.summaryChars),
    hints: item.hints.slice(0, 8).map((hint) => truncate(hint, 80)),
    topArtifacts: item.topArtifacts.slice(0, 5).map((artifact) => truncate(artifact, 160)),
    openWork: compactList(item.openWork, 5, 180),
    lastTouchedAt: item.lastTouchedAt,
    lastTouchedLabel: item.lastTouchedLabel,
    attentionScore: Math.round(item.attentionScore * 1000) / 1000,
    ...(item.nextStep?.trim() ? { nextStep: truncate(item.nextStep, LIMITS.summaryChars) } : {}),
    ...(item.activatedReason?.trim() ? { activatedReason: truncate(item.activatedReason, 160) } : {}),
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

function compactActiveAttachments(attachments: ActiveAttachmentRef[]): AgentContextPack["activeAttachments"] {
  return attachments.slice(0, LIMITS.activeAttachments).map((attachment) => ({
    attachmentKind: attachment.attachmentKind,
    ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
    ...(attachment.documentId ? { documentId: attachment.documentId } : {}),
    ...(attachment.fileId ? { fileId: attachment.fileId } : {}),
    ...(attachment.directoryId ? { directoryId: attachment.directoryId } : {}),
    displayName: truncate(attachment.displayName, 160),
    kind: attachment.kind,
    ...(attachment.mode ? { mode: attachment.mode } : {}),
    ...(attachment.capabilities?.length ? { capabilities: compactList(attachment.capabilities, 6, 40) } : {}),
    runId: attachment.runId,
    runPath: attachment.runPath,
    ...(attachment.preparedInputId ? { preparedInputId: attachment.preparedInputId } : {}),
    ...(attachment.path ? { path: truncate(attachment.path, 180) } : {}),
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
