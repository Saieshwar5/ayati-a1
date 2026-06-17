import type { ConversationExchange, ContinuityContext } from "../../memory/types.js";
import type { LoopState } from "../types.js";

const LIMITS = {
  recentConversation: 5,
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
  continuity: ContinuityContext;
  personalMemorySnapshot?: string;
  activeLearningContext?: string;
}

export function buildAgentContextPack(state: LoopState): AgentContextPack {
  return {
    currentInput: truncate(state.userMessage, LIMITS.textChars),
    continuity: compactContinuity(state.continuity),
    ...(state.personalMemorySnapshot?.trim()
      ? { personalMemorySnapshot: truncate(state.personalMemorySnapshot, LIMITS.memoryChars) }
      : {}),
    ...(state.activeLearningContext?.trim()
      ? { activeLearningContext: truncate(state.activeLearningContext, LIMITS.learningChars) }
      : {}),
    recentConversation: compactRecentConversation(state.recentExchanges ?? [], state.runId),
  };
}

function compactContinuity(continuity: ContinuityContext | undefined): ContinuityContext {
  if (!continuity) {
    return { mode: "new", confidence: 0, reasons: ["no continuity resolver result"] };
  }
  return {
    mode: continuity.mode,
    confidence: Math.round(continuity.confidence * 1000) / 1000,
    reasons: compactList(continuity.reasons, 4, 180),
    ...(continuity.current ? {
      current: {
        activityId: continuity.current.activityId,
        kind: continuity.current.kind,
        title: truncate(continuity.current.title, 120),
        ...(continuity.current.goal?.trim() ? { goal: truncate(continuity.current.goal, LIMITS.summaryChars) } : {}),
        openWork: compactList(continuity.current.openWork, 5, 180),
        ...(continuity.current.nextStep?.trim() ? { nextStep: truncate(continuity.current.nextStep, LIMITS.summaryChars) } : {}),
        verifiedFacts: compactList(continuity.current.verifiedFacts, 6, 180),
        topAssets: compactList(continuity.current.topAssets, 5, 160),
        lastTouchedAt: continuity.current.lastTouchedAt,
      },
    } : {}),
    ...(continuity.candidates && continuity.candidates.length > 0 ? {
      candidates: continuity.candidates.slice(0, 3).map((candidate) => ({
        activityId: candidate.activityId,
        kind: candidate.kind,
        title: truncate(candidate.title, 120),
        reason: truncate(candidate.reason, 180),
        score: Math.round(candidate.score * 1000) / 1000,
        topAssets: compactList(candidate.topAssets, 5, 160),
        lastTouchedAt: candidate.lastTouchedAt,
      })),
    } : {}),
  };
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
