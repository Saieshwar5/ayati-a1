import type { SessionMemory } from "../memory/types.js";
import type { ContextEngineMachineContext } from "../context-engine/index.js";

export interface HarnessContextInput {
  activeLearningContext?: string;
  contextEngine?: ContextEngineMachineContext;
}

export interface HarnessContext {
  activeLearningContext?: string;
  personalMemorySnapshot: string;
  contextEngine?: ContextEngineMachineContext;
}

export interface BuildHarnessContextInput {
  sessionMemory: SessionMemory;
  clientId: string;
  sessionId?: string;
  userMessage: string;
  input?: HarnessContextInput;
}

export function createInitialHarnessContext(input?: HarnessContextInput): HarnessContext {
  return {
    activeLearningContext: input?.activeLearningContext,
    personalMemorySnapshot: "",
    contextEngine: input?.contextEngine,
  };
}

export function buildHarnessContextFromSources(input: BuildHarnessContextInput): HarnessContext {
  const memoryContext = input.sessionMemory.getPromptMemoryContext();

  return {
    activeLearningContext: input.input?.activeLearningContext,
    personalMemorySnapshot: memoryContext.personalMemorySnapshot ?? "",
    contextEngine: input.input?.contextEngine,
  };
}

export interface HarnessContextTarget {
  harnessContext: HarnessContext;
}

export function applyHarnessContextToState(target: HarnessContextTarget, context: HarnessContext): void {
  target.harnessContext = context;
}

export function harnessContextFromState(target: HarnessContextTarget): HarnessContext {
  return target.harnessContext;
}
