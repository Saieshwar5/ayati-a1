import type { ContextEngineMachineContext } from "../context-engine/index.js";

export interface HarnessContextInput {
  contextEngine?: ContextEngineMachineContext;
}

export interface HarnessContext {
  contextEngine?: ContextEngineMachineContext;
}

export interface BuildHarnessContextInput {
  input?: HarnessContextInput;
}

export function createInitialHarnessContext(input?: HarnessContextInput): HarnessContext {
  return {
    contextEngine: input?.contextEngine,
  };
}

export function buildHarnessContextFromSources(input: BuildHarnessContextInput): HarnessContext {
  return {
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
