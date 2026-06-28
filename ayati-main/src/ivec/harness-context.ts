import type { ContextEngineMachineContext } from "../context-engine/index.js";

export interface HarnessContextInput {
  personalMemorySnapshot?: string;
  contextEngine?: ContextEngineMachineContext;
}

export interface HarnessContext {
  personalMemorySnapshot: string;
  contextEngine?: ContextEngineMachineContext;
}

export interface BuildHarnessContextInput {
  input?: HarnessContextInput;
}

export function createInitialHarnessContext(input?: HarnessContextInput): HarnessContext {
  return {
    personalMemorySnapshot: input?.personalMemorySnapshot ?? "",
    contextEngine: input?.contextEngine,
  };
}

export function buildHarnessContextFromSources(input: BuildHarnessContextInput): HarnessContext {
  return {
    personalMemorySnapshot: input.input?.personalMemorySnapshot ?? "",
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
