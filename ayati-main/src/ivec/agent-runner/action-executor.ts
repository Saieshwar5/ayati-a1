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

export interface AgentActionExecutionDeps {
  toolExecutor?: ToolExecutor;
  selectedTools: ToolDefinition[];
  config: LoopConfig;
  clientId: string;
  uiContext?: AgentUiContext;
  sessionMemory: SessionMemory;
  runHandle: MemoryRunHandle;
  runPath: string;
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

  const calls = action.calls.slice(0, resolveMaxCalls(deps.config, action));
  const actOutput = await executeCalls(deps, action, calls, stepNumber);
  const assertionResults = collectToolAssertionResults(actOutput);
  const failedAssertions = assertionResults.filter((assertion) => assertion.status === "failed" && assertion.severity === "required");
  const passed = actOutput.toolCalls.every((call) => !call.error) && failedAssertions.length === 0;
  const evidenceItems = buildEvidenceItems(actOutput);
  const newFacts = buildNewFacts(actOutput);
  const artifacts = uniqueArtifacts(actOutput.toolCalls.flatMap((call) => call.artifacts ?? []))
    .map((artifact) => artifact.path ?? artifact.uri ?? artifact.id ?? artifact.label ?? "artifact")
    .filter((artifact) => artifact.trim().length > 0);
  const summary = passed
    ? `Executed ${actOutput.toolCalls.length} tool call${actOutput.toolCalls.length === 1 ? "" : "s"} with deterministic verification.`
    : summarizeActionFailure(actOutput, failedAssertions.map((assertion) => assertion.message));
  const verifyOutput = buildVerifyOutput(
    passed,
    actOutput,
    evidenceItems,
    newFacts,
    artifacts,
    summary,
    assertionResults,
  );
  const reducedWorkState = reduceVerifiedWorkState(previousWorkState, {
    passed,
    summary,
    evidenceItems,
    newFacts,
  });

  return {
    actOutput,
    verifyOutput,
    nextWorkState: mergeWorkEvidenceRefs(reducedWorkState, previousWorkState, collectWorkEvidenceRefs(actOutput)),
  };
}

function validateActionPlan(deps: AgentActionExecutionDeps, action: AgentAction): string | undefined {
  if (!deps.toolExecutor) {
    return "No tool executor is available for action execution.";
  }
  if (action.mode === "autonomous") {
    return "Autonomous actions are not enabled yet; return a concrete single, sequential, or parallel action.";
  }
  if (action.calls.length === 0) {
    return "Action contains no tool calls.";
  }
  if (action.mode === "single" && action.calls.length !== 1) {
    return `Single action must contain exactly one tool call, received ${action.calls.length}.`;
  }
  if (action.calls.length > deps.config.maxTotalToolCallsPerStep) {
    return `Action requested ${action.calls.length} calls, above max ${deps.config.maxTotalToolCallsPerStep}.`;
  }

  const selectedToolNames = new Set(deps.selectedTools.map((tool) => tool.name));
  for (const call of action.calls) {
    if (!selectedToolNames.has(call.tool)) {
      return `Tool '${call.tool}' was not selected for this decision.`;
    }
  }

  if (action.mode === "parallel" && hasUnsafeParallelFilesystemCalls(deps.selectedTools, action.calls)) {
    return "Parallel action has overlapping or mutating filesystem calls; use sequential mode.";
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
  for (const call of calls) {
    if (call.dependsOn.some((dep) => failedCallIds.has(dep))) {
      const skipped: ActToolCallRecord = {
        callId: call.id,
        tool: call.tool,
        input: call.input,
        output: "",
        error: `Skipped because dependency failed: ${call.dependsOn.join(", ")}`,
      };
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }

    const result = await executeToolCall(deps, call, stepNumber);
    if (result.error) {
      failedCallIds.add(call.id);
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
    recordRunMetric(deps.metrics, `tool:${call.tool}`, {
      durationMs: Date.now() - startedAt,
      kind: "tool",
      status: "failed",
    });
    throw error;
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
    toolDefinition,
  });
  if (observationResult.observation) {
    record.observation = observationResult.observation;
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
): VerifyOutput {
  const toolFailures = actOutput.toolCalls.filter((call) => call.error).length;
  return {
    passed,
    method: "execution_gate",
    executionStatus: actOutput.toolCalls.length === 0
      ? "no_tools"
      : toolFailures === 0
        ? "all_succeeded"
        : toolFailures === actOutput.toolCalls.length
          ? "all_failed"
          : "partial_success",
    validationStatus: passed ? "passed" : "failed",
    summary,
    evidenceSummary: evidenceItems.slice(0, 6).join(" "),
    evidenceItems,
    newFacts,
    artifacts,
    usedRawArtifacts: [],
    expectationCheckStatus: assertionResults.some((assertion) => assertion.status === "failed" && assertion.severity === "required")
      ? "failed"
      : passed
        ? "passed"
        : "skipped",
    expectationCheckSummary: assertionResults.length > 0
      ? assertionResults.map((assertion) => `${assertion.id}:${assertion.status}`).join("; ")
      : undefined,
  };
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

function resolveMaxCalls(config: LoopConfig, action: AgentAction): number {
  return Math.max(1, Math.min(action.maxCalls ?? config.maxTotalToolCallsPerStep, config.maxTotalToolCallsPerStep));
}

function hasUnsafeParallelFilesystemCalls(selectedTools: ToolDefinition[], calls: AgentToolCallSpec[]): boolean {
  const byName = new Map(selectedTools.map((tool) => [tool.name, tool]));
  const mutatingFilesystemCalls = calls.filter((call) => {
    const tool = byName.get(call.tool);
    return tool?.annotations?.domain === "filesystem" && tool.annotations.readOnly === false;
  });
  if (mutatingFilesystemCalls.length <= 1) {
    return false;
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
