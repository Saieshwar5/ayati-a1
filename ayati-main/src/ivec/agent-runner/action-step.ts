import type {
  ActToolCallRecord,
  AgentLoopDeps,
  LoopConfig,
  LoopState,
  RunToolCallContext,
  ToolObservation,
} from "../types.js";
import type { RunMetrics } from "../metrics.js";
import { recordRunMetric } from "../metrics.js";
import { compactToolContext } from "../state-compaction.js";
import { executeAgentAction } from "./action-executor.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import type { AgentDecision } from "./decision.js";
import { buildToolProjectionMetadata } from "./tool-context-projectors/metadata.js";
import { planLocalRecovery } from "./failure-policy.js";
import {
  buildStepSummary,
  type ExecuteActionStepResult,
} from "./step-lifecycle.js";
import type { ToolDefinition } from "../../skills/types.js";
import { requireRunHandle } from "./runner-state.js";
import {
  isWorkstreamRoutingObservationTool,
  workstreamRoutingEvidenceReference,
} from "./workstream-routing-evidence.js";
import { deriveFilesystemCompletionEvidence } from "./filesystem-completion-evidence.js";
import { toolCallVerificationPassed } from "./tool-call-verification.js";
import { isAbsolute } from "node:path";
import { compactSupersededConversationPages } from "./conversation-page-context.js";

export interface ExecuteActionStepInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  metrics: RunMetrics;
  selectedTools: ToolDefinition[];
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
  preserveWorkState?: boolean;
}

export async function executeActionStep(input: ExecuteActionStepInput): Promise<ExecuteActionStepResult> {
  const runHandle = requireRunHandle(input.deps);
  const workstreamResources = isWorkstreamBound(input.state)
    ? input.state.harnessContext.contextEngine?.workstream?.resources
    : undefined;
  const filesystemMutationRoots = input.state.virtualMode.mutationScopes
    .filter(isAbsolute);
  let execution = await executeAgentAction(
    {
      toolExecutor: input.deps.toolExecutor,
      selectedTools: input.selectedTools,
      config: input.config,
      clientId: input.deps.clientId,
      runHandle,
      metrics: input.metrics,
      workstreamResources,
      filesystemMutationRoots,
    },
    input.decision.action,
    input.stepNumber,
    input.state.workState,
  );

  if (!execution.verifyOutput.passed) {
    const recovery = planLocalRecovery(input.decision.action, execution.actOutput.toolCalls);
    if (recovery) {
      recordRunMetric(input.metrics, "local_recovery", { kind: "local" });
      const retryExecution = await executeAgentAction(
        {
          toolExecutor: input.deps.toolExecutor,
          selectedTools: input.selectedTools,
          config: input.config,
          clientId: input.deps.clientId,
          runHandle,
          metrics: input.metrics,
          workstreamResources,
          filesystemMutationRoots,
        },
        recovery.action,
        input.stepNumber,
        input.state.workState,
      );
      execution = mergeRecoveredExecution(execution, retryExecution, recovery.reason);
    }
  }

  await applyToolStateUpdates(input.state, input.deps, execution.actOutput.toolCalls);
  if (input.preserveWorkState) {
    execution = {
      ...execution,
      nextWorkState: input.state.workState,
    };
  }
  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
  });

  return {
    execution,
    stepSummary,
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

export async function applyToolStateUpdates(state: LoopState, deps: AgentLoopDeps, calls: ActToolCallRecord[]): Promise<void> {
  for (const update of calls.flatMap((call) => readToolStateUpdates(call.meta))) {
    if (update["type"] === "sync_hot_context_mounts") {
      if (deps.hotContextRuntime) {
        state.hotContext = deps.hotContextRuntime.project(deps.clientId, state.runId);
      }
      continue;
    }
    if (update["type"] === "restore_managed_file") {
      await syncManagedFilesFromLibrary(state, deps);
      continue;
    }
    if (update["type"] === "restore_managed_directory") {
      await syncManagedDirectoriesFromLibrary(state, deps);
      continue;
    }
  }
}

export function buildUpdatedToolContext(
  state: LoopState,
  execution: AgentActionExecutionResult,
  stepNumber: number,
  options: {
    stepKind?: RunToolCallContext["stepKind"];
  } = {},
): LoopState["toolContext"] {
  const toolCalls = compactSupersededConversationPages([
    ...(state.toolContext?.toolCalls ?? []),
    ...execution.actOutput.toolCalls.map((call) => toRunToolCallContext(
      state.runId,
      stepNumber,
      call,
      options,
    )),
  ]);
  return compactToolContext({
    recent: getLatestObservations(execution),
    toolCalls,
  });
}

async function syncManagedFilesFromLibrary(state: LoopState, deps: AgentLoopDeps): Promise<void> {
  if (!deps.fileLibrary) {
    return;
  }
  state.managedFiles = await deps.fileLibrary.listRunFiles(state.runId);
}

async function syncManagedDirectoriesFromLibrary(state: LoopState, deps: AgentLoopDeps): Promise<void> {
  if (!deps.directoryLibrary) {
    return;
  }
  state.managedDirectories = await deps.directoryLibrary.listRunDirectories(state.runId);
}

function readToolStateUpdates(meta: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const raw = meta?.["stateUpdates"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function mergeRecoveredExecution(
  first: AgentActionExecutionResult,
  retry: AgentActionExecutionResult,
  reason: string,
): AgentActionExecutionResult {
  return {
    actOutput: {
      toolCalls: [...first.actOutput.toolCalls, ...retry.actOutput.toolCalls],
      finalText: retry.actOutput.finalText,
      stoppedEarlyReason: retry.actOutput.stoppedEarlyReason,
    },
    verifyOutput: {
      ...retry.verifyOutput,
      evidenceItems: [reason, ...first.verifyOutput.evidenceItems, ...retry.verifyOutput.evidenceItems],
      evidenceSummary: [reason, first.verifyOutput.evidenceSummary, retry.verifyOutput.evidenceSummary]
        .filter((item) => item.trim().length > 0)
        .join(" "),
    },
    nextWorkState: retry.nextWorkState,
  };
}

function getLatestObservations(execution: AgentActionExecutionResult): ToolObservation[] {
  return execution.actOutput.toolCalls
    .map((call) => call.observation)
    .filter((observation): observation is NonNullable<ActToolCallRecord["observation"]> => observation !== undefined);
}

function toRunToolCallContext(
  runId: string,
  step: number,
  call: ActToolCallRecord,
  options: {
    stepKind?: RunToolCallContext["stepKind"];
  },
): RunToolCallContext {
  const transientContext = options.stepKind === "transient_context";
  const verificationPassed = toolCallVerificationPassed(call);
  const projectionMetadata = buildToolProjectionMetadata(call.tool, call.result?.structuredContent);
  const completionEvidence = transientContext
    ? []
    : deriveFilesystemCompletionEvidence(call, step, verificationPassed);
  const evidenceRef = transientContext
    ? undefined
    : call.observation?.evidenceRef
      ?? (isWorkstreamRoutingObservationTool(call.tool)
        ? workstreamRoutingEvidenceReference(runId, step, call.callId)
        : undefined);
  return {
    step,
    ...(options.stepKind ? { stepKind: options.stepKind } : {}),
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    ...(call.purpose ? { purpose: call.purpose } : {}),
    input: call.input,
    status: call.error ? "failed" : "success",
    ...(call.observation?.retention ? { retention: call.observation.retention } : {}),
    ...(projectionMetadata ? { projectionMetadata } : {}),
    output: call.output,
    ...(call.error ? { error: call.error } : {}),
    ...(call.code ? { code: call.code } : {}),
    ...(call.result?.error?.category
      ? { errorCategory: call.result.error.category }
      : {}),
    ...(call.result?.error?.target
      ? { errorTarget: call.result.error.target }
      : {}),
    ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
    ...(call.artifacts && call.artifacts.length > 0 ? { artifacts: call.artifacts } : {}),
    ...(call.observation?.hasMore !== undefined ? { hasMore: call.observation.hasMore } : {}),
    ...(!transientContext && runId.trim().length > 0
      ? { stepRef: { runId, step, ...(call.callId ? { callId: call.callId } : {}) } }
      : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
    ...(call.verification ? { verification: call.verification } : {}),
    verificationPassed,
    ...(completionEvidence.length > 0 ? { completionEvidence } : {}),
  };
}
