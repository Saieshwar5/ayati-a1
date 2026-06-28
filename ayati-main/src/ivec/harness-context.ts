import type { SessionMemory } from "../memory/types.js";
import type { ContextEngineMachineContext } from "../context-engine/index.js";

export interface HarnessContextInput {
  contextEngine?: ContextEngineMachineContext;
}

export interface HarnessContext {
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
    personalMemorySnapshot: "",
    contextEngine: input?.contextEngine,
  };
}

export function buildHarnessContextFromSources(input: BuildHarnessContextInput): HarnessContext {
  const memoryContext = input.sessionMemory.getPromptMemoryContext();

  return {
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
