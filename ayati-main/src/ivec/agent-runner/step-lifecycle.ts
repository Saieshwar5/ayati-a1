import type { MemoryRunHandle } from "../../memory/types.js";
import type {
  ActToolCallRecord,
  AgentLoopDeps,
  LoopState,
  StepSummary,
} from "../types.js";
import type { GitMemorySessionStepRecord, GitMemoryStepRecord } from "../../context-engine/index.js";
import type { AgentAction } from "./decision.js";
import type { AgentActionExecutionResult } from "./action-executor.js";

export interface ExecuteActionStepResult {
  execution: AgentActionExecutionResult;
  stepSummary: StepSummary;
}

export function buildStepSummary(input: {
  stepNumber: number;
  action: AgentAction;
  execution: AgentActionExecutionResult;
}): StepSummary {
  const toolSuccessCount = input.execution.actOutput.toolCalls.filter((call) => !call.error).length;
  const toolFailureCount = input.execution.actOutput.toolCalls.length - toolSuccessCount;
  const artifacts = [
    ...input.execution.actOutput.toolCalls.flatMap((call) => (call.artifacts ?? []).map((artifact) => artifact.path ?? artifact.uri ?? artifact.id ?? "")),
    ...input.execution.verifyOutput.artifacts,
  ].filter((artifact) => artifact.trim().length > 0);
  const failure = classifyFailure(input.execution);
  const evidenceMetadata = buildStepEvidenceMetadata(input.execution.actOutput.toolCalls);

  return {
    step: input.stepNumber,
    executionContract: buildActionExecutionContract(input.action),
    outcome: input.execution.verifyOutput.passed ? "success" : "failed",
    summary: input.execution.verifyOutput.summary,
    newFacts: input.execution.verifyOutput.newFacts,
    artifacts: [...new Set(artifacts)],
    toolsUsed: [...new Set(input.execution.actOutput.toolCalls.map((call) => call.tool))],
    toolSuccessCount,
    toolFailureCount,
    contractVersion: 2,
    verificationPolicy: "deterministic",
    verificationRationale: "The runner uses tool result contracts and local assertions before any semantic model review.",
    expectedArtifacts: [],
    expectedStateChange: "Verified facts and work state are updated from tool-owned evidence.",
    requiresFullStepContext: false,
    expectationCheckStatus: input.execution.verifyOutput.expectationCheckStatus,
    expectationCheckSummary: input.execution.verifyOutput.expectationCheckSummary,
    verificationMethod: input.execution.verifyOutput.method,
    executionStatus: input.execution.verifyOutput.executionStatus,
    validationStatus: input.execution.verifyOutput.validationStatus,
    evidenceSummary: input.execution.verifyOutput.evidenceSummary,
    evidenceItems: input.execution.verifyOutput.evidenceItems,
    ...evidenceMetadata,
    usedRawArtifacts: input.execution.verifyOutput.usedRawArtifacts,
    workState: input.execution.nextWorkState,
    stoppedEarlyReason: input.execution.actOutput.stoppedEarlyReason,
    failureType: failure.failureType,
    blockedTargets: failure.blockedTargets,
  };
}

export function recordTaskStep(
  deps: AgentLoopDeps,
  state: LoopState,
  action: AgentAction,
  stepResult: ExecuteActionStepResult,
  timing: {
    startedAt: string;
    completedAt: string;
  },
): void {
  if (!deps.recordTaskStep || !state.runId || state.runClass !== "task") {
    return;
  }
  const taskId = state.harnessContext.contextEngine?.task?.workId
    ?? state.harnessContext.contextEngine?.pendingTurn?.workId;
  if (!taskId) {
    return;
  }
  deps.recordTaskStep(buildGitMemoryStepRecord({
    taskId,
    runId: state.runId,
    action,
    stepResult,
    timing,
  }));
}

export function recordSessionStep(
  deps: AgentLoopDeps,
  sessionRunHandle: MemoryRunHandle | undefined,
  action: AgentAction,
  stepResult: ExecuteActionStepResult,
  timing: {
    startedAt: string;
    completedAt: string;
  },
): void {
  if (!deps.recordSessionStep || !sessionRunHandle?.runId) {
    return;
  }
  deps.recordSessionStep(buildGitMemorySessionStepRecord({
    sessionId: sessionRunHandle.sessionId,
    runId: sessionRunHandle.runId,
    action,
    stepResult,
    timing,
  }));
}

function buildStepEvidenceMetadata(calls: ActToolCallRecord[]): Pick<StepSummary, "evidenceSource" | "outputSize" | "lineCount" | "truncated"> {
  const sources = calls.map(buildToolEvidenceSource);
  const outputSize = sumNumbers(calls.map((call) => call.rawOutputChars ?? call.observation?.rawOutputChars));
  const lineCount = sumNumbers(calls.map((call) => call.observation?.lineCount));
  const truncated = calls.some((call) => call.outputTruncated === true || call.observation?.hasMore === true);
  return {
    ...(sources.length > 0 ? { evidenceSource: { kind: "tool-output", toolCalls: sources } } : {}),
    ...(outputSize !== undefined ? { outputSize } : {}),
    ...(lineCount !== undefined ? { lineCount } : {}),
    ...(calls.length > 0 ? { truncated } : {}),
  };
}

function buildToolEvidenceSource(call: ActToolCallRecord): Record<string, unknown> {
  return pruneUndefined({
    kind: "tool-output",
    tool: call.tool,
    callId: call.callId,
    status: call.error ? "failed" : "success",
    operationStatus: call.operationStatus,
    code: call.code,
    evidenceRef: call.observation?.evidenceRef,
    rawOutputChars: call.rawOutputChars ?? call.observation?.rawOutputChars,
    lineCount: call.observation?.lineCount,
    truncated: call.outputTruncated,
    ...selectedSourceFields(call.input),
    ...selectedSourceFields(call.result?.structuredContent),
  });
}

function buildGitMemorySessionStepRecord(input: {
  sessionId: string;
  runId: string;
  action: AgentAction;
  stepResult: ExecuteActionStepResult;
  timing: {
    startedAt: string;
    completedAt: string;
  };
}): GitMemorySessionStepRecord {
  const step = input.stepResult.stepSummary;
  const verification = input.stepResult.execution.verifyOutput;
  const status = step.outcome === "failed" ? "failed" : step.outcome === "skipped" ? "skipped" : "completed";
  return {
    v: 1,
    sessionId: input.sessionId,
    runId: input.runId,
    step: step.step,
    status,
    startedAt: input.timing.startedAt,
    completedAt: input.timing.completedAt,
    summary: step.summary,
    decision: {
      actionKind: "tool_calls",
      mode: input.action.mode,
      allowedTools: input.action.allowedTools,
      assertions: input.action.assertions,
    },
    action: {
      executionContract: step.executionContract,
      calls: input.action.calls,
      toolsUsed: step.toolsUsed ?? [],
      toolSuccessCount: step.toolSuccessCount,
      toolFailureCount: step.toolFailureCount,
      stoppedEarlyReason: step.stoppedEarlyReason,
    },
    toolCalls: input.stepResult.execution.actOutput.toolCalls.map((call) => ({
      ...call,
      status: call.error ? "failed" : "success",
    })),
    verification: {
      passed: verification.passed,
      policy: step.verificationPolicy,
      method: verification.method,
      executionStatus: verification.executionStatus,
      validationStatus: verification.validationStatus,
      summary: verification.summary,
      evidenceSummary: verification.evidenceSummary,
      evidenceItems: verification.evidenceItems,
      newFacts: verification.newFacts,
      artifacts: verification.artifacts,
      usedRawArtifacts: verification.usedRawArtifacts,
      expectationCheckStatus: verification.expectationCheckStatus,
      expectationCheckSummary: verification.expectationCheckSummary,
    },
    workStateAfter: input.stepResult.execution.nextWorkState,
    facts: uniqueStrings([
      ...step.newFacts,
      ...verification.newFacts,
      ...(step.evidenceItems ?? []),
    ]),
    artifacts: uniqueStrings([
      ...step.artifacts,
      ...verification.artifacts,
    ]),
    outputSize: step.outputSize,
    lineCount: step.lineCount,
    truncated: step.truncated,
    failureType: step.failureType,
    blockedTargets: step.blockedTargets,
  };
}

function buildGitMemoryStepRecord(input: {
  taskId: string;
  runId: string;
  action: AgentAction;
  stepResult: ExecuteActionStepResult;
  timing: {
    startedAt: string;
    completedAt: string;
  };
}): GitMemoryStepRecord {
  const step = input.stepResult.stepSummary;
  const verification = input.stepResult.execution.verifyOutput;
  const status = step.outcome === "failed" ? "failed" : step.outcome === "skipped" ? "skipped" : "completed";
  return {
    v: 1,
    taskId: input.taskId,
    runId: input.runId,
    step: step.step,
    status,
    startedAt: input.timing.startedAt,
    completedAt: input.timing.completedAt,
    summary: step.summary,
    decision: {
      actionKind: "tool_calls",
      mode: input.action.mode,
      allowedTools: input.action.allowedTools,
      assertions: input.action.assertions,
    },
    action: {
      executionContract: step.executionContract,
      calls: input.action.calls,
      toolsUsed: step.toolsUsed ?? [],
      toolSuccessCount: step.toolSuccessCount,
      toolFailureCount: step.toolFailureCount,
      stoppedEarlyReason: step.stoppedEarlyReason,
    },
    toolCalls: input.stepResult.execution.actOutput.toolCalls.map((call) => ({
      ...call,
      status: call.error ? "failed" : "success",
    })),
    verification: {
      passed: verification.passed,
      policy: step.verificationPolicy,
      method: verification.method,
      executionStatus: verification.executionStatus,
      validationStatus: verification.validationStatus,
      summary: verification.summary,
      evidenceSummary: verification.evidenceSummary,
      evidenceItems: verification.evidenceItems,
      newFacts: verification.newFacts,
      artifacts: verification.artifacts,
      usedRawArtifacts: verification.usedRawArtifacts,
      expectationCheckStatus: verification.expectationCheckStatus,
      expectationCheckSummary: verification.expectationCheckSummary,
    },
    workStateAfter: input.stepResult.execution.nextWorkState,
    facts: uniqueStrings([
      ...step.newFacts,
      ...verification.newFacts,
      ...(step.evidenceItems ?? []),
    ]),
    artifacts: uniqueStrings([
      ...step.artifacts,
      ...verification.artifacts,
    ]),
    ...(step.outputSize !== undefined ? { outputSize: step.outputSize } : {}),
    ...(step.lineCount !== undefined ? { lineCount: step.lineCount } : {}),
    ...(step.truncated !== undefined ? { truncated: step.truncated } : {}),
    ...(step.failureType ? { failureType: step.failureType } : {}),
    ...(step.blockedTargets?.length ? { blockedTargets: step.blockedTargets } : {}),
  };
}

function selectedSourceFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["path", "filePath", "dirPath", "cwd", "query", "pattern", "cmd", "command", "scriptPath", "exitCode", "timedOut", "matchCount", "patchIndex", "failedEditIndex", "mode"] as const) {
    const selected = compactSourceValue(record[key]);
    if (selected !== undefined) {
      output[key] = selected;
    }
  }
  const operationKind = compactSourceValue(record["kind"]);
  if (operationKind !== undefined) {
    output["operationKind"] = operationKind;
  }
  const diagnostic = compactDiagnostic(record["diagnostic"]);
  if (diagnostic) {
    output["diagnostic"] = diagnostic;
  }
  return output;
}

function compactDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["targetKind", "reason", "expectedPreview", "hint", "nearestMatchPreview", "nearestMatchLine", "matchStrategy"] as const) {
    const selected = compactSourceValue(record[key]);
    if (selected !== undefined) {
      output[key] = selected;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function compactSourceValue(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 10)
      .map((item) => item.trim().slice(0, 200));
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function sumNumbers(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}

function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function buildActionExecutionContract(action: AgentAction): string {
  const calls = action.calls.map((call) => `${call.tool}${call.purpose ? ` (${call.purpose})` : ""}`).join(", ");
  return `${action.mode} action: ${calls || "no calls"}`;
}

function classifyFailure(execution: AgentActionExecutionResult): {
  failureType?: StepSummary["failureType"];
  blockedTargets: string[];
} {
  if (execution.verifyOutput.passed) {
    return { blockedTargets: [] };
  }

  if (
    execution.verifyOutput.executionStatus === "no_tools"
    || execution.verifyOutput.summary === "Step produced no output to validate."
    || execution.verifyOutput.summary === "Action contains no tool calls."
  ) {
    return {
      failureType: "no_progress",
      blockedTargets: [],
    };
  }

  const failedCalls = execution.actOutput.toolCalls.filter((call) => call.error);
  const categories = failedCalls.map((call) => call.result?.error?.category);
  const failureType: StepSummary["failureType"] = categories.includes("permission")
    ? "permission"
    : categories.includes("missing_path")
      ? "missing_path"
      : categories.includes("validation")
        ? "validation_error"
        : failedCalls.length > 0
          ? "tool_error"
          : "verify_failed";
  const blockedTargets = failedCalls
    .map((call) => call.result?.error?.target)
    .filter((target): target is string => typeof target === "string" && target.trim().length > 0);
  return {
    failureType,
    blockedTargets,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
