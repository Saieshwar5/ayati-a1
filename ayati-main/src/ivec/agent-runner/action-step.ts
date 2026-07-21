import type { MemoryRunHandle, RunRecorder } from "../../memory/types.js";
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

const noopRunRecorder: RunRecorder = {
  recordToolCall(): void {
    return;
  },
  recordToolResult(): void {
    return;
  },
  recordAssistantFinal(): void {
    return;
  },
  recordRunFailure(): void {
    return;
  },
  recordAgentStep(): void {
    return;
  },
};

export interface ExecuteActionStepInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  metrics: RunMetrics;
  selectedTools: ToolDefinition[];
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
  runHandle?: MemoryRunHandle;
}

export async function executeActionStep(input: ExecuteActionStepInput): Promise<ExecuteActionStepResult> {
  const runHandle = input.runHandle ?? memoryRunHandle(requireRunHandle(input.deps));
  const workstreamResources = isWorkstreamBound(input.state)
    ? input.state.harnessContext.contextEngine?.workstream?.resources
    : undefined;
  let execution = await executeAgentAction(
    {
      toolExecutor: input.deps.toolExecutor,
      selectedTools: input.selectedTools,
      config: input.config,
      clientId: input.deps.clientId,
      ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
      runRecorder: input.deps.runRecorder ?? noopRunRecorder,
      runHandle,
      metrics: input.metrics,
      workstreamResources,
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
          ...(input.deps.uiContext ? { uiContext: input.deps.uiContext } : {}),
          runRecorder: input.deps.runRecorder ?? noopRunRecorder,
          runHandle,
          metrics: input.metrics,
          workstreamResources,
        },
        recovery.action,
        input.stepNumber,
        input.state.workState,
      );
      execution = mergeRecoveredExecution(execution, retryExecution, recovery.reason);
    }
  }

  await applyToolStateUpdates(input.state, input.deps, execution.actOutput.toolCalls);
  syncPreparedAttachmentsFromRegistry(input.state, input.deps);

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

function memoryRunHandle(
  handle: ReturnType<typeof requireRunHandle>,
): MemoryRunHandle {
  return {
    sessionId: handle.streamId,
    runId: handle.runId,
    triggerSeq: handle.triggerSeq,
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

export async function applyToolStateUpdates(state: LoopState, deps: AgentLoopDeps, calls: ActToolCallRecord[]): Promise<void> {
  for (const update of calls.flatMap((call) => readToolStateUpdates(call.meta))) {
    if (update["type"] === "restore_prepared_attachment") {
      syncPreparedAttachmentsFromRegistry(state, deps);
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
    if (update["type"] === "mark_document_indexed") {
      const preparedInputId = readString(update["preparedInputId"]);
      if (!preparedInputId) continue;
      deps.preparedAttachmentRegistry?.updateAttachmentSummary(state.runId, preparedInputId, (summary) => ({
        ...summary,
        ...(summary.unstructured ? {
          unstructured: {
            ...summary.unstructured,
            indexed: update["indexed"] === true,
          },
        } : {}),
      }));
      continue;
    }
    if (update["type"] === "mark_dataset_staged") {
      const preparedInputId = readString(update["preparedInputId"]);
      if (!preparedInputId) continue;
      deps.preparedAttachmentRegistry?.updateAttachmentSummary(state.runId, preparedInputId, (summary) => ({
        ...summary,
        ...(summary.structured ? {
          structured: {
            ...summary.structured,
            staged: update["staged"] === true,
            ...(readString(update["stagingDbPath"]) ? { stagingDbPath: readString(update["stagingDbPath"])! } : {}),
            ...(readString(update["stagingTableName"]) ? { stagingTableName: readString(update["stagingTableName"])! } : {}),
          },
        } : {}),
      }));
      continue;
    }
  }
}

export function syncPreparedAttachmentsFromRegistry(state: LoopState, deps: AgentLoopDeps): void {
  const records = deps.preparedAttachmentRegistry?.getRunAttachments(state.runId) ?? [];
  if (records.length === 0) {
    return;
  }
  state.preparedAttachmentRecords = records;
  state.preparedAttachments = records.map((record) => record.summary);
}

export function buildUpdatedToolContext(
  state: LoopState,
  execution: AgentActionExecutionResult,
): LoopState["toolContext"] {
  return compactToolContext({
    recent: getLatestObservations(execution),
    toolCalls: [
      ...(state.toolContext?.toolCalls ?? []),
      ...execution.actOutput.toolCalls.map((call) => toRunToolCallContext(state.runId, state.iteration, call)),
    ],
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function toRunToolCallContext(runId: string, step: number, call: ActToolCallRecord): RunToolCallContext {
  const projectionMetadata = buildToolProjectionMetadata(call.tool, call.result?.structuredContent);
  return {
    step,
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
    ...(call.operationStatus ? { operationStatus: call.operationStatus } : {}),
    ...(call.artifacts && call.artifacts.length > 0 ? { artifacts: call.artifacts } : {}),
    ...(call.observation?.hasMore !== undefined ? { hasMore: call.observation.hasMore } : {}),
    ...(runId.trim().length > 0 ? { stepRef: { runId, step, ...(call.callId ? { callId: call.callId } : {}) } } : {}),
    ...(call.observation?.evidenceRef ? { evidenceRef: call.observation.evidenceRef } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
  };
}
