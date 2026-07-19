import type { SessionInputHandle } from "../../memory/types.js";
import type { AgentRunHandle } from "ayati-git-context";
import type {
  AgentLoopDeps,
  LoopConfig,
  LoopState,
  WorkState,
} from "../types.js";
import {
  applyHarnessContextToState,
  buildHarnessContextFromSources,
  createInitialHarnessContext,
  type HarnessContextInput,
} from "../harness-context.js";
import { createRoutingAttemptState as emptyRoutingAttemptState } from "./workstream-routing-policy.js";
import { createInitialContextPressureState } from "../context-pressure-state.js";
import { createTimelineCheckpointCache } from "./timeline-checkpoint-cache.js";

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
    inputKind: deps.inputKind ?? (deps.systemEvent ? "system_event" : "user_message"),
    userMessage: "",
    systemEvent: deps.systemEvent,
    originSource: deps.systemEvent?.source,
    systemEventIntentKind: deps.systemEventIntentKind,
    systemEventRequestedAction: deps.systemEventRequestedAction,
    systemEventCreatedBy: deps.systemEventCreatedBy,
    handlingMode: deps.systemEventHandlingMode,
    approvalRequired: deps.systemEventApprovalRequired,
    approvalState: deps.systemEventApprovalState,
    contextVisibility: deps.systemEventContextVisibility,
    preferredResponseKind: deps.preferredResponseKind,
    workState: emptyWorkState(),
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: config.maxIterations,
    consecutiveFailures: 0,
    completedSteps: [],
    routingAttempts: emptyRoutingAttemptState(),
    runPath: "",
    failureHistory: [],
    contextPressure: createInitialContextPressureState(),
    timelineCheckpointCache: createTimelineCheckpointCache(),
    attachedDocuments: deps.attachedDocuments ?? [],
    attachmentWarnings: deps.attachmentWarnings ?? [],
    preparedAttachments: [],
    preparedAttachmentRecords: [],
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
      sessionId: deps.runHandle.sessionId,
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
}

export function getPrimaryUserMessage(deps: AgentLoopDeps): string {
  const override = deps.userMessageOverride?.trim();
  if (override) {
    return override;
  }
  const systemEventSummary = deps.systemEvent?.summary?.trim();
  if (systemEventSummary) {
    return systemEventSummary;
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

function emptyWorkState(): WorkState {
  return {
    status: "not_done",
    openWork: [],
    blockers: [],
    summary: "",
    verifiedFacts: [],
    evidence: [],
  };
}
