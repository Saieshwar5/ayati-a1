import type { SessionInputHandle } from "../../memory/types.js";
import type { AgentRunHandle } from "ayati-context-engine";
import type {
  AgentLoopDeps,
  LoopConfig,
  LoopState,
} from "../types.js";
import {
  applyHarnessContextToState,
  buildHarnessContextFromSources,
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../harness-context.js";
import { createInitialContextPressureState } from "../context-pressure-state.js";
import {
  buildRunHotContextEntries,
  emptyHotContextProjection,
} from "../hot-context/index.js";
import { createEntryVirtualModeState } from "./virtual-mode.js";
import { emptyWorkState } from "./work-state/contracts.js";

export function buildInitialState(
  deps: AgentLoopDeps,
  config: LoopConfig,
  inputHandle: SessionInputHandle,
  runHandle: AgentRunHandle,
): LoopState {
  const harnessContext = createInitialHarnessContext(harnessContextInputFromDeps(deps));
  return {
    runId: runHandle.runId,
    currentSeq: inputHandle.seq,
    ...(inputHandle.currentMessageId ? { currentMessageId: inputHandle.currentMessageId } : {}),
    inputKind: "user_message",
    userMessage: "",
    preferredResponseKind: deps.preferredResponseKind,
    workState: emptyWorkState(),
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: config.maxIterations,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    hotContext: deps.hotContextRuntime?.project(deps.clientId, runHandle.runId)
      ?? emptyHotContextProjection(),
    contextPressure: createInitialContextPressureState(),
    attachmentWarnings: deps.attachmentWarnings ?? [],
    managedFiles: deps.managedFiles ?? [],
    managedDirectories: deps.managedDirectories ?? [],
    harnessContext,
    toolContext: { recent: [] },
  };
}

export function resolveInputHandle(deps: AgentLoopDeps): SessionInputHandle {
  if (deps.inputHandle) {
    return deps.inputHandle;
  }
  if (deps.runHandle) {
    return {
      sessionId: deps.runHandle.streamId,
      seq: deps.runHandle.triggerSeq ?? 1,
    };
  }
  throw new Error("Agent loop requires a session input handle.");
}

export function requireRunHandle(deps: AgentLoopDeps): AgentRunHandle {
  return deps.runHandle;
}

export function syncHarnessContext(state: LoopState, deps: AgentLoopDeps, _inputHandle: SessionInputHandle): void {
  applyHarnessContextToState(state, buildHarnessContextFromSources({
    input: harnessContextInputFromDeps(deps),
  }));
  syncPersistedWorkState(state);
  syncRunHotContext(state, deps);
}

export function getPrimaryUserMessage(deps: AgentLoopDeps): string {
  const override = deps.userMessageOverride?.trim();
  if (override) {
    return override;
  }
  const initial = deps.initialUserMessage?.trim();
  if (initial) {
    return initial;
  }
  return "";
}

function harnessContextInputFromDeps(deps: AgentLoopDeps): HarnessContextInput {
  return deps.harnessContext ?? {};
}

function syncRunHotContext(state: LoopState, deps: AgentLoopDeps): void {
  if (!deps.hotContextRuntime) return;
  const supportedKeys = new Set(deps.hotContextRuntime.keys());
  deps.hotContextRuntime.syncRun({
    clientId: deps.clientId,
    runId: state.runId,
    entries: buildRunHotContextEntries({
      context: state.harnessContext.contextEngine,
    }).filter((entry) => supportedKeys.has(entry.key)),
  });
  state.hotContext = deps.hotContextRuntime.project(deps.clientId, state.runId);
}

function syncPersistedWorkState(state: LoopState): void {
  const persisted = state.harnessContext.contextEngine?.run?.workState;
  if (!persisted || persisted.revision <= state.workStateRuntime.revision) return;
  state.workState = {
    status: persisted.status,
    summary: persisted.summary,
    plan: persisted.plan,
    importantContext: persisted.importantContext,
    ...(persisted.nextAction ? { nextAction: persisted.nextAction } : {}),
  };
  state.workStateRuntime = {
    revision: persisted.revision,
    afterStep: persisted.afterStep,
    updateReason: persisted.updateReason,
    updatedAt: persisted.updatedAt,
  };
}
