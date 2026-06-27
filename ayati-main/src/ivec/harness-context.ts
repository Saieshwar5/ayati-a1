import { ContinuityResolver } from "../memory/activity/continuity-resolver.js";
import type {
  ActivityAssetRef,
  ActivityTaskBoundary,
  ContinuityContext,
  ConversationExchange,
  PromptSessionEvent,
  SessionMemory,
  SessionWorkContext,
  TaskThreadContext,
} from "../memory/types.js";
import type { ContextEngineMachineContext } from "../context-engine/index.js";

export interface HarnessContextInput {
  activeLearningContext?: string;
  contextEngine?: ContextEngineMachineContext;
}

export interface HarnessContext {
  activeLearningContext?: string;
  personalMemorySnapshot: string;
  continuity: ContinuityContext;
  durableTaskBoundary?: ActivityTaskBoundary;
  recentExchanges: ConversationExchange[];
  sessionEvents: PromptSessionEvent[];
  activeContextStartSeq: number;
  sessionWork: SessionWorkContext;
  taskThreadContext?: TaskThreadContext;
  contextEngine?: ContextEngineMachineContext;
}

export interface BuildHarnessContextInput {
  sessionMemory: SessionMemory;
  clientId: string;
  sessionId?: string;
  userMessage: string;
  currentAssetRefs: ActivityAssetRef[];
  input?: HarnessContextInput;
}

export function createInitialHarnessContext(input?: HarnessContextInput): HarnessContext {
  return {
    activeLearningContext: input?.activeLearningContext,
    personalMemorySnapshot: "",
    continuity: { mode: "new", confidence: 0, reasons: ["initial state"] },
    recentExchanges: [],
    sessionEvents: [],
    activeContextStartSeq: 1,
    sessionWork: {
      activeContextStartSeq: 1,
      recentActivities: [],
    },
    contextEngine: input?.contextEngine,
  };
}

export function buildHarnessContextFromSources(input: BuildHarnessContextInput): HarnessContext {
  const memoryContext = input.sessionMemory.getPromptMemoryContext();
  const activeContextStartSeq = memoryContext.activeContextStartSeq ?? 1;
  const store = input.sessionMemory.getActivityStore?.();
  const durableTaskBoundary = input.sessionId
    ? store?.findLatestDurableTaskBoundary(input.clientId, input.sessionId) ?? undefined
    : undefined;

  return {
    activeLearningContext: input.input?.activeLearningContext,
    personalMemorySnapshot: memoryContext.personalMemorySnapshot ?? "",
    continuity: resolveContinuity({
      sessionMemory: input.sessionMemory,
      clientId: input.clientId,
      sessionId: input.sessionId,
      userMessage: input.userMessage,
      currentAssetRefs: input.currentAssetRefs,
    }),
    durableTaskBoundary,
    recentExchanges: memoryContext.recentExchanges ?? [],
    sessionEvents: memoryContext.sessionEvents ?? [],
    activeContextStartSeq,
    sessionWork: memoryContext.sessionWork ?? {
      activeContextStartSeq,
      recentActivities: [],
    },
    taskThreadContext: memoryContext.taskThreadContext,
    contextEngine: input.input?.contextEngine,
  };
}

export interface HarnessContextTarget {
  activeLearningContext?: string;
  personalMemorySnapshot?: string;
  continuity?: ContinuityContext;
  durableTaskBoundary?: ActivityTaskBoundary;
  recentExchanges: ConversationExchange[];
  sessionEvents?: PromptSessionEvent[];
  activeContextStartSeq?: number;
  sessionWork?: SessionWorkContext;
  taskThreadContext?: TaskThreadContext;
  contextEngineContext?: ContextEngineMachineContext;
}

export function applyHarnessContextToState(target: HarnessContextTarget, context: HarnessContext): void {
  target.activeLearningContext = context.activeLearningContext;
  target.personalMemorySnapshot = context.personalMemorySnapshot;
  target.continuity = context.continuity;
  target.durableTaskBoundary = context.durableTaskBoundary;
  target.recentExchanges = context.recentExchanges;
  target.sessionEvents = context.sessionEvents;
  target.activeContextStartSeq = context.activeContextStartSeq;
  target.sessionWork = context.sessionWork;
  target.taskThreadContext = context.taskThreadContext;
  target.contextEngineContext = context.contextEngine;
}

function resolveContinuity(input: {
  sessionMemory: SessionMemory;
  clientId: string;
  sessionId?: string;
  userMessage: string;
  currentAssetRefs: ActivityAssetRef[];
}): ContinuityContext {
  const store = input.sessionMemory.getActivityStore?.();
  if (!store) {
    return { mode: "new", confidence: 0, reasons: ["activity store is not configured"] };
  }
  if (!input.sessionId) {
    return { mode: "new", confidence: 0, reasons: ["session id is not available"] };
  }
  const resolver = new ContinuityResolver({ store });
  return resolver.resolve({
    clientId: input.clientId,
    sessionId: input.sessionId,
    userMessage: input.userMessage,
    currentAssetRefs: input.currentAssetRefs,
  });
}
