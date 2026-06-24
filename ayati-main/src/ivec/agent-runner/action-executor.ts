import type { AgentUiContext } from "../../ui/context.js";
import type { MemoryRunHandle, SessionMemory } from "../../memory/types.js";
import type {
  ActOutput,
  ActToolCallRecord,
  LoopConfig,
  VerifyOutput,
} from "../types.js";
import type { ToolExecutor } from "../../skills/tool-executor.js";
import type { ToolDefinition, ToolResult } from "../../skills/types.js";
import type { RunMetrics } from "../metrics.js";
import { recordRunMetric } from "../metrics.js";
import { uniqueArtifacts } from "../../verification/artifact-assertions.js";
import type { AgentAction, AgentToolCallSpec } from "./decision.js";
import { reduceVerifiedWorkState } from "../verification-contracts/progress-reducer.js";
import type { WorkEvidenceRef, WorkState } from "../types.js";
import { buildToolObservation } from "./observation-builder.js";
import {
  checkDeterministicSuccessGate,
  checkVerificationGates,
  deriveExecutionStatus,
} from "../verification-gates.js";
import { buildTaskNotesFromActOutput } from "./task-notes.js";

export interface AgentActionExecutionDeps {
  toolExecutor?: ToolExecutor;
  selectedTools: ToolDefinition[];
  config: LoopConfig;
  clientId: string;
  uiContext?: AgentUiContext;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  runPath: string;
  activityId?: string;
  metrics?: RunMetrics;
}

export interface AgentActionExecutionResult {
  actOutput: ActOutput;
  verifyOutput: VerifyOutput;
  nextWorkState: WorkState;
}

export async function executeAgentAction(
  deps: AgentActionExecutionDeps,
  action: AgentAction,
  stepNumber: number,
  previousWorkState: WorkState,
): Promise<AgentActionExecutionResult> {
  const planError = validateActionPlan(deps, action);
  if (planError) {
    const actOutput: ActOutput = {
      toolCalls: [{
        tool: "execution_plan",
        input: action,
        output: "",
        error: planError,
      }],
      finalText: "",
      stoppedEarlyReason: "planned_call_failed",
    };
    const verifyOutput = buildVerifyOutput(false, actOutput, [], [], [], planError);
    return {
      actOutput,
      verifyOutput,
      nextWorkState: reduceVerifiedWorkState(previousWorkState, {
        passed: false,
        summary: verifyOutput.summary,
        evidenceItems: verifyOutput.evidenceItems,
        newFacts: verifyOutput.newFacts,
      }),
    };
  }

  const actOutput = await executeCalls(deps, action, action.calls, stepNumber);
  const verifyOutput = verifyActOutput(action, actOutput);
  const taskNotes = buildTaskNotesFromActOutput(actOutput);
  const reducedWorkState = reduceVerifiedWorkState(previousWorkState, {
    passed: verifyOutput.passed,
    summary: verifyOutput.summary,
    evidenceItems: verifyOutput.evidenceItems,
    newFacts: verifyOutput.newFacts,
    taskNotes,
  });

  return {
    actOutput,
    verifyOutput,
    nextWorkState: mergeWorkEvidenceRefs(reducedWorkState, previousWorkState, collectWorkEvidenceRefs(actOutput)),
  };
}

function verifyActOutput(action: AgentAction, actOutput: ActOutput): VerifyOutput {
  const assertionResults = collectToolAssertionResults(actOutput);
  const failedAssertions = assertionResults.filter((assertion) => assertion.status === "failed" && assertion.severity === "required");
  const evidenceItems = buildEvidenceItems(actOutput);
  const newFacts = buildNewFacts(actOutput);
  const artifacts = uniqueArtifacts(actOutput.toolCalls.flatMap((call) => call.artifacts ?? []))
    .map((artifact) => artifact.path ?? artifact.uri ?? artifact.id ?? artifact.label ?? "artifact")
    .filter((artifact) => artifact.trim().length > 0);

  const planCoverageFailure = checkPlannedCallCoverage(action, actOutput);
  if (planCoverageFailure) {
    return buildVerifyOutput(
      false,
      actOutput,
      [...evidenceItems, planCoverageFailure],
      newFacts,
      artifacts,
      planCoverageFailure,
      assertionResults,
      { method: "execution_gate", validationStatus: "failed" },
    );
  }

  const executionGate = checkVerificationGates(actOutput);
  if (executionGate) {
    return mergeGateVerifyOutput(executionGate, {
      evidenceItems,
      newFacts,
      artifacts,
      assertionResults,
    });
  }

  if (failedAssertions.length > 0) {
    return buildVerifyOutput(
      false,
      actOutput,
      evidenceItems,
      newFacts,
      artifacts,
      summarizeActionFailure(actOutput, failedAssertions.map((assertion) => assertion.message)),
      assertionResults,
      { method: "script", validationStatus: "failed" },
    );
  }

  const deterministicSuccess = checkDeterministicSuccessGate(actOutput, buildActionSuccessCriteria(action));
  if (deterministicSuccess) {
    return mergeGateVerifyOutput(deterministicSuccess, {
      evidenceItems,
      newFacts,
      artifacts,
      assertionResults,
    });
  }

  const passed = actOutput.toolCalls.every((call) => !call.error);
  const hasContractProof = hasToolContractProof(actOutput);
  const summary = passed
    ? hasContractProof
      ? `Executed ${actOutput.toolCalls.length} tool call${actOutput.toolCalls.length === 1 ? "" : "s"} with deterministic verification.`
      : `Executed ${actOutput.toolCalls.length} tool call${actOutput.toolCalls.length === 1 ? "" : "s"} successfully; no deterministic verification contract was available.`
    : summarizeActionFailure(actOutput, []);
  return buildVerifyOutput(
    passed,
    actOutput,
    evidenceItems,
    newFacts,
    artifacts,
    summary,
    assertionResults,
    {
      method: hasContractProof ? "script" : "execution_gate",
      validationStatus: hasContractProof ? "passed" : "skipped",
    },
  );
}

function validateActionPlan(deps: AgentActionExecutionDeps, action: AgentAction): string | undefined {
  if (!deps.toolExecutor) {
    return "No tool executor is available for action execution.";
  }
  if (action.calls.length === 0) {
    return "Action contains no tool calls.";
  }
  if (action.mode === "single" && action.calls.length !== 1) {
    return `Single action must contain exactly one tool call, received ${action.calls.length}.`;
  }
  if (action.mode === "sequential" && action.calls.length > deps.config.maxSequentialToolCallsPerStep) {
    return `Sequential action requested ${action.calls.length} calls, above max ${deps.config.maxSequentialToolCallsPerStep}.`;
  }
  if (action.mode === "parallel" && action.calls.length > deps.config.maxParallelToolCallsPerStep) {
    return `Parallel action requested ${action.calls.length} calls, above max ${deps.config.maxParallelToolCallsPerStep}.`;
  }
  if (action.calls.length > deps.config.maxTotalToolCallsPerStep) {
    return `Action requested ${action.calls.length} calls, above max ${deps.config.maxTotalToolCallsPerStep}.`;
  }

  const callIds = new Set<string>();
  for (const call of action.calls) {
    if (!call.id.trim()) {
      return "Action contains a tool call with an empty id.";
    }
    if (callIds.has(call.id)) {
      return `Action contains duplicate tool call id: ${call.id}.`;
    }
    callIds.add(call.id);
  }

  if (action.mode === "single" && action.calls[0]?.dependsOn.length) {
    return "Single action tool calls cannot depend on other calls.";
  }
  if (action.mode === "parallel" && action.calls.some((call) => call.dependsOn.length > 0)) {
    return "Parallel action tool calls cannot depend on other calls; use sequential mode.";
  }
  if (action.mode === "sequential") {
    const previousIds = new Set<string>();
    for (const call of action.calls) {
      for (const dep of call.dependsOn) {
        if (!previousIds.has(dep)) {
          return `Sequential call '${call.id}' depends on '${dep}', which is not an earlier call.`;
        }
      }
      previousIds.add(call.id);
    }
  }

  const selectedToolNames = new Set(deps.selectedTools.map((tool) => tool.name));
  const allowedToolNames = new Set(action.allowedTools);
  const validationContext = {
    clientId: deps.clientId,
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    ...(deps.activityId ? { activityId: deps.activityId } : {}),
    ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
  };
  for (const tool of action.allowedTools) {
    if (!selectedToolNames.has(tool)) {
      return `Allowed tool '${tool}' was not selected for this decision.`;
    }
  }
  for (const call of action.calls) {
    if (!selectedToolNames.has(call.tool)) {
      return `Tool '${call.tool}' was not selected for this decision.`;
    }
    if (!allowedToolNames.has(call.tool)) {
      return `Tool '${call.tool}' was not listed in action.allowedTools.`;
    }
    const validation = deps.toolExecutor.validate(call.tool, call.input, validationContext);
    if (!validation.valid) {
      const inputKeys = call.input && typeof call.input === "object" && !Array.isArray(call.input)
        ? Object.keys(call.input as Record<string, unknown>)
        : [];
      return [
        `Tool input preflight failed for '${call.tool}': ${validation.error}`,
        `received input keys: ${inputKeys.length > 0 ? inputKeys.join(", ") : "(none)"}`,
      ].join("; ");
    }
  }

  if (action.mode === "parallel") {
    const parallelSafetyError = validateParallelActionSafety(deps.selectedTools, action.calls);
    if (parallelSafetyError) {
      return parallelSafetyError;
    }
  }

  return undefined;
}

async function executeCalls(
  deps: AgentActionExecutionDeps,
  action: AgentAction,
  calls: AgentToolCallSpec[],
  stepNumber: number,
): Promise<ActOutput> {
  if (action.mode === "parallel") {
    const toolCalls = await Promise.all(calls.map((call) => executeToolCall(deps, call, stepNumber)));
    return { toolCalls, finalText: "" };
  }

  const toolCalls: ActToolCallRecord[] = [];
  const failedCallIds = new Set<string>();
  let stoppedByFailure: string | undefined;
  for (const call of calls) {
    if (stoppedByFailure) {
      const skipped = skippedToolCall(call, `Skipped because an earlier sequential call failed: ${stoppedByFailure}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }
    if (call.dependsOn.some((dep) => failedCallIds.has(dep))) {
      const skipped = skippedToolCall(call, `Skipped because dependency failed: ${call.dependsOn.join(", ")}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }

    const result = await executeToolCall(deps, call, stepNumber);
    if (result.error) {
      failedCallIds.add(call.id);
      stoppedByFailure = `${call.tool}: ${result.error}`;
    }
    toolCalls.push(result);
  }

  return { toolCalls, finalText: "" };
}

async function executeToolCall(
  deps: AgentActionExecutionDeps,
  call: AgentToolCallSpec,
  stepNumber: number,
): Promise<ActToolCallRecord> {
  if (!deps.toolExecutor) {
    return { tool: call.tool, input: call.input, output: "", error: "No tool executor available." };
  }

  const context = {
    clientId: deps.clientId,
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    ...(deps.activityId ? { activityId: deps.activityId } : {}),
    stepNumber,
    ...(deps.uiContext ? { uiContext: deps.uiContext } : {}),
  };
  const validation = deps.toolExecutor.validate(call.tool, call.input, context);
  if (!validation.valid) {
    return {
      callId: call.id,
      tool: call.tool,
      input: call.input,
      output: "",
      error: validation.error,
    };
  }

  deps.sessionMemory.recordToolCall(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepId: stepNumber,
    toolCallId: call.id,
    toolName: call.tool,
    args: call.input,
  });

  const startedAt = Date.now();
  let result: ToolResult;
  try {
    result = await deps.toolExecutor.execute(call.tool, call.input, context);
    recordRunMetric(deps.metrics, `tool:${call.tool}`, {
      durationMs: Date.now() - startedAt,
      kind: "tool",
      status: result.ok ? "success" : "failed",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordRunMetric(deps.metrics, `tool:${call.tool}`, {
      durationMs: Date.now() - startedAt,
      kind: "tool",
      status: "failed",
    });
    deps.sessionMemory.recordToolResult(deps.clientId, {
      runId: deps.runHandle.runId,
      sessionId: deps.runHandle.sessionId,
      stepId: stepNumber,
      toolCallId: call.id,
      toolName: call.tool,
      status: "failed",
      output: "",
      errorMessage: message,
    });
    return {
      callId: call.id,
      tool: call.tool,
      input: call.input,
      output: "",
      error: message,
    };
  }

  const record: ActToolCallRecord = {
    callId: call.id,
    tool: call.tool,
    input: call.input,
    output: result.output ?? "",
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
    ...(result.v2 ? { result: result.v2 } : {}),
    ...(result.v2?.operationStatus ? { operationStatus: result.v2.operationStatus } : {}),
    ...(result.v2?.code ? { code: result.v2.code } : {}),
    ...(result.v2?.artifacts ? { artifacts: result.v2.artifacts } : {}),
    ...(result.v2?.verification?.facts ? { verifiedFacts: result.v2.verification.facts } : {}),
    ...(result.v2?.verification?.assertions ? { assertionResults: result.v2.verification.assertions } : {}),
  };
  const toolDefinition = deps.selectedTools.find((tool) => tool.name === call.tool);
  const observationResult = await buildToolObservation({
    runPath: deps.runPath,
    stepNumber,
    call,
    record,
    rawOutput: result.rawOutput,
    toolDefinition,
  });
  if (observationResult.observation) {
    record.observation = observationResult.observation;
    record.output = observationResult.observation.content;
  }
  if (observationResult.rawOutputPath) {
    record.rawOutputPath = observationResult.rawOutputPath;
    record.outputStorage = "raw_file";
  }
  if (typeof observationResult.rawOutputChars === "number") {
    record.rawOutputChars = observationResult.rawOutputChars;
  }
  if (observationResult.outputTruncated) {
    record.outputTruncated = true;
  }
  if (observationResult.evidenceRef) {
    record.evidenceRef = observationResult.evidenceRef;
    record.artifacts = [...(record.artifacts ?? []), { kind: "file", path: observationResult.evidenceRef.rawOutputPath }];
    record.meta = {
      ...(record.meta ?? {}),
      evidenceRef: observationResult.evidenceRef,
    };
  }

  deps.sessionMemory.recordToolResult(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepId: stepNumber,
    toolCallId: call.id,
    toolName: call.tool,
    status: record.error ? "failed" : "success",
    output: record.output,
    errorMessage: record.error,
  });

  return record;
}

function skippedToolCall(call: AgentToolCallSpec, reason: string): ActToolCallRecord {
  return {
    callId: call.id,
    tool: call.tool,
    input: call.input,
    output: "",
    error: reason,
    meta: { skipped: true },
  };
}

function checkPlannedCallCoverage(action: AgentAction, actOutput: ActOutput): string | undefined {
  const plannedIds = new Set(action.calls.map((call) => call.id));
  const resultIds = new Set(actOutput.toolCalls.map((call) => call.callId ?? ""));
  const missing = [...plannedIds].filter((id) => !resultIds.has(id));
  const unexpected = actOutput.toolCalls
    .map((call) => call.callId)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !plannedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0 || actOutput.toolCalls.length !== action.calls.length) {
    const details = [
      missing.length > 0 ? `missing planned calls: ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected calls: ${unexpected.join(", ")}` : "",
      actOutput.toolCalls.length !== action.calls.length
        ? `planned ${action.calls.length} call(s), recorded ${actOutput.toolCalls.length}`
        : "",
    ].filter((item) => item.length > 0).join("; ");
    return `Action execution did not record every planned tool call: ${details}.`;
  }
  return undefined;
}

function collectToolAssertionResults(actOutput: ActOutput): NonNullable<ActToolCallRecord["assertionResults"]> {
  return actOutput.toolCalls.flatMap((call) => call.assertionResults ?? []);
}

function buildVerifyOutput(
  passed: boolean,
  actOutput: ActOutput,
  evidenceItems: string[],
  newFacts: string[],
  artifacts: string[],
  summary: string,
  assertionResults: NonNullable<ActToolCallRecord["assertionResults"]> = [],
  options: {
    method?: VerifyOutput["method"];
    validationStatus?: VerifyOutput["validationStatus"];
    usedRawArtifacts?: string[];
  } = {},
): VerifyOutput {
  return {
    passed,
    method: options.method ?? "execution_gate",
    executionStatus: deriveExecutionStatus(actOutput),
    validationStatus: options.validationStatus ?? (passed ? "passed" : "failed"),
    summary,
    evidenceSummary: evidenceItems.slice(0, 6).join(" "),
    evidenceItems,
    newFacts,
    artifacts,
    usedRawArtifacts: options.usedRawArtifacts ?? [],
    expectationCheckStatus: assertionResults.some((assertion) => assertion.status === "failed" && assertion.severity === "required")
      ? "failed"
      : assertionResults.length > 0 && passed
        ? "passed"
        : "skipped",
    expectationCheckSummary: assertionResults.length > 0
      ? assertionResults.map((assertion) => `${assertion.id}:${assertion.status}`).join("; ")
      : undefined,
  };
}

function mergeGateVerifyOutput(
  gateOutput: VerifyOutput,
  details: {
    evidenceItems: string[];
    newFacts: string[];
    artifacts: string[];
    assertionResults: NonNullable<ActToolCallRecord["assertionResults"]>;
  },
): VerifyOutput {
  const evidenceItems = uniqueStrings([...gateOutput.evidenceItems, ...details.evidenceItems]);
  const newFacts = details.newFacts.length > 0
    ? details.newFacts
    : uniqueStrings([...gateOutput.newFacts, ...details.newFacts]);
  const artifacts = uniqueStrings([...gateOutput.artifacts, ...details.artifacts]);
  const usedRawArtifacts = uniqueStrings(gateOutput.usedRawArtifacts);
  const failedRequiredAssertion = details.assertionResults.some((assertion) => assertion.status === "failed" && assertion.severity === "required");
  const expectationCheckStatus = failedRequiredAssertion
    ? "failed"
    : details.assertionResults.length > 0 && gateOutput.passed
      ? "passed"
      : gateOutput.expectationCheckStatus ?? "skipped";
  const expectationCheckSummary = details.assertionResults.length > 0
    ? details.assertionResults.map((assertion) => `${assertion.id}:${assertion.status}`).join("; ")
    : gateOutput.expectationCheckSummary;

  return {
    ...gateOutput,
    evidenceItems,
    evidenceSummary: uniqueStrings([gateOutput.evidenceSummary, details.evidenceItems.slice(0, 6).join(" ")]).join(" "),
    newFacts,
    artifacts,
    usedRawArtifacts,
    expectationCheckStatus,
    expectationCheckSummary,
  };
}

function hasToolContractProof(actOutput: ActOutput): boolean {
  return actOutput.toolCalls.some((call) => (
    call.result?.verification?.status === "passed"
    || (call.assertionResults ?? []).some((assertion) => assertion.status === "passed" && assertion.severity === "required")
    || (call.verifiedFacts ?? []).length > 0
  ));
}

function buildActionSuccessCriteria(action: AgentAction): string {
  const purposes = action.calls
    .map((call) => call.purpose?.replace(/\s+/g, " ").trim() ?? "")
    .filter((purpose) => purpose.length > 0);
  if (purposes.length > 0) {
    return purposes.join("; ");
  }
  return action.calls.map((call) => `${call.tool} completed`).join("; ");
}

function buildEvidenceItems(actOutput: ActOutput): string[] {
  return uniqueStrings([
    ...actOutput.toolCalls.flatMap((call) => [
      call.result?.verification?.summary,
      call.result?.message,
      ...(call.assertionResults ?? []).map((assertion) => `${call.tool}.${assertion.id}: ${assertion.message}`),
      ...(call.verifiedFacts ?? []).map((fact) => fact.message),
      call.evidenceRef ? `${call.tool} raw output saved as ${call.evidenceRef.ref}.` : undefined,
      call.error ? `${call.tool} failed: ${call.error}` : undefined,
    ]),
  ]).slice(0, 12);
}

function buildNewFacts(actOutput: ActOutput): string[] {
  return uniqueStrings([
    ...actOutput.toolCalls.flatMap((call) => [
      ...(call.verifiedFacts ?? []).map((fact) => fact.message),
      ...(call.assertionResults ?? []).flatMap((assertion) => (assertion.facts ?? []).map((fact) => fact.message)),
    ]),
  ]).slice(0, 12);
}

function collectWorkEvidenceRefs(actOutput: ActOutput): WorkEvidenceRef[] {
  return actOutput.toolCalls
    .map((call) => call.evidenceRef)
    .filter((ref): ref is WorkEvidenceRef => ref !== undefined);
}

function mergeWorkEvidenceRefs(
  next: WorkState,
  previous: WorkState,
  refs: WorkEvidenceRef[],
): WorkState {
  const byId = new Map<string, WorkEvidenceRef>();
  for (const ref of previous.evidenceRefs ?? []) {
    byId.set(ref.id, ref);
  }
  for (const ref of refs) {
    byId.set(ref.id, ref);
  }
  const evidenceRefs = [...byId.values()].slice(-12);
  return {
    ...next,
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  };
}

function summarizeActionFailure(actOutput: ActOutput, assertionFailures: string[]): string {
  const toolFailures = actOutput.toolCalls
    .filter((call) => call.error)
    .map((call) => `${call.tool}: ${call.error}`);
  const reasons = [...toolFailures, ...assertionFailures].filter((reason) => reason.trim().length > 0);
  return reasons.length > 0
    ? `Action failed: ${reasons.slice(0, 3).join(" | ")}`
    : "Action failed.";
}

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  "calculator",
  "read_file",
  "list_directory",
  "search_in_files",
  "evidence_next_chunk",
  "evidence_read_lines",
  "evidence_tail",
  "evidence_search",
]);

const PARALLEL_SAFE_DOMAINS = new Set([
  "calculator",
  "filesystem",
  "general",
]);

function validateParallelActionSafety(selectedTools: ToolDefinition[], calls: AgentToolCallSpec[]): string | undefined {
  const byName = new Map(selectedTools.map((tool) => [tool.name, tool]));

  for (const call of calls) {
    const tool = byName.get(call.tool);
    if (!tool) {
      return `Parallel action rejected: tool '${call.tool}' was not selected.`;
    }
    const annotations = tool.annotations;
    if (!annotations) {
      return `Parallel action rejected: tool '${call.tool}' has no safety annotations. Use sequential mode.`;
    }
    if (!PARALLEL_SAFE_TOOL_NAMES.has(tool.name)) {
      return `Parallel action rejected: tool '${tool.name}' is not parallel-safe. Use sequential mode.`;
    }
    if (!PARALLEL_SAFE_DOMAINS.has(annotations.domain)) {
      return `Parallel action rejected: tool '${tool.name}' domain '${annotations.domain}' is not parallel-safe. Use sequential mode.`;
    }
    if (!annotations.readOnly) {
      return `Parallel action rejected: tool '${tool.name}' is not read-only. Use sequential mode.`;
    }
    if (annotations.mutatesWorkspace) {
      return `Parallel action rejected: tool '${tool.name}' mutates the workspace. Use sequential mode.`;
    }
    if (annotations.mutatesExternalWorld) {
      return `Parallel action rejected: tool '${tool.name}' mutates external state. Use sequential mode.`;
    }
    if (annotations.destructive) {
      return `Parallel action rejected: tool '${tool.name}' is destructive. Use sequential mode.`;
    }
    if (!annotations.retrySafe) {
      return `Parallel action rejected: tool '${tool.name}' is not retry-safe. Use sequential mode.`;
    }
    if (annotations.longRunning) {
      return `Parallel action rejected: tool '${tool.name}' is long-running. Use sequential mode.`;
    }
  }

  if (hasUnsafeParallelFilesystemCalls(selectedTools, calls)) {
    return "Parallel action rejected: filesystem calls are not independent. Use sequential mode.";
  }

  return undefined;
}

function hasUnsafeParallelFilesystemCalls(selectedTools: ToolDefinition[], calls: AgentToolCallSpec[]): boolean {
  const byName = new Map(selectedTools.map((tool) => [tool.name, tool]));
  const filesystemCalls = calls.filter((call) => byName.get(call.tool)?.annotations?.domain === "filesystem");
  const mutatingFilesystemCalls = filesystemCalls.filter((call) => {
    const tool = byName.get(call.tool);
    return tool?.annotations?.domain === "filesystem" && tool.annotations.readOnly === false;
  });
  if (mutatingFilesystemCalls.length === 0) {
    return false;
  }
  if (filesystemCalls.length > 1) {
    return true;
  }

  const targets = new Set<string>();
  for (const call of mutatingFilesystemCalls) {
    for (const target of filesystemTargets(call.input)) {
      if (targets.has(target)) {
        return true;
      }
      targets.add(target);
    }
  }
  return targets.size === 0;
}

function filesystemTargets(input: Record<string, unknown>): string[] {
  const targets: string[] = [];
  for (const field of ["path", "filePath", "source", "destination"]) {
    const value = input[field];
    if (typeof value === "string" && value.trim().length > 0) {
      targets.push(value);
    }
  }
  const files = input["files"];
  if (Array.isArray(files)) {
    for (const file of files) {
      if (typeof file === "object" && file !== null && !Array.isArray(file)) {
        const path = (file as Record<string, unknown>)["path"];
        if (typeof path === "string" && path.trim().length > 0) {
          targets.push(path);
        }
      }
    }
  }
  return targets;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter((value) => value.length > 0))];
}
