import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmMessage, LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type {
  ExecutorDeps,
  StepDirective,
  StepSummary,
  FailedApproach,
  ActOutput,
  ActToolCallRecord,
  VerifyOutput,
  TaskStatus,
  TaskProgressState,
  PreparedAttachmentStateUpdate,
  StepPlanCall,
  VerificationExecutionStatus,
} from "./types.js";
import {
  writeStepMarkdown,
  queueStepMarkdownWrite,
  writeStepArtifactText,
  formatActMarkdown,
  formatVerifyMarkdown,
} from "./state-persistence.js";
import type { StepRecord } from "./run-state-manager.js";
import { checkVerificationGates, deriveExecutionStatus } from "./verification-gates.js";
import { formatToolResult, formatValidationError } from "./tool-helpers.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";

export async function executeStep(
  deps: ExecutorDeps,
  directive: StepDirective,
  stepNumber: number,
  runPath: string,
): Promise<StepSummary & { stepRecord: StepRecord; fullStepText: string }> {
  const pad = String(stepNumber).padStart(3, "0");

  const actOut = await act(deps, directive, stepNumber, runPath);
  const actMarkdownPath = `steps/${pad}-act.md`;
  const verifyMarkdownPath = `steps/${pad}-verify.md`;
  const actMarkdownWrite = queueStepMarkdownWrite(runPath, actMarkdownPath, formatActMarkdown(actOut));

  let verifyOut: VerifyOutput;
  try {
    verifyOut = await verify(deps, actOut, directive.success_criteria, runPath);
  } finally {
    await actMarkdownWrite;
  }
  writeStepMarkdown(runPath, verifyMarkdownPath, formatVerifyMarkdown(verifyOut, actOut.toolCalls));
  const fullStepText = [
    `Step ${stepNumber}`,
    formatActMarkdown(actOut),
    formatVerifyMarkdown(verifyOut, actOut.toolCalls),
  ].join("\n\n");

  const artifacts = [
    ...new Set([actMarkdownPath, verifyMarkdownPath, ...collectActArtifacts(actOut.toolCalls), ...verifyOut.artifacts]),
  ];
  const newFacts = buildStepNewFacts(actOut.toolCalls, verifyOut.newFacts);
  const stateUpdates = buildStepStateUpdates(actOut.toolCalls);

  const classification = verifyOut.passed
    ? { failureType: undefined, blockedTargets: undefined }
    : classifyFailure(actOut.toolCalls, verifyOut.evidenceSummary);
  const toolSuccessCount = actOut.toolCalls.filter((call) => !call.error).length;
  const toolFailureCount = actOut.toolCalls.length - toolSuccessCount;
  const executionContract = getDirectiveExecutionContract(directive);

  return {
    step: stepNumber,
    executionContract,
    outcome: verifyOut.passed ? "success" : "failed",
    summary: verifyOut.summary,
    newFacts,
    artifacts,
    toolSuccessCount,
    toolFailureCount,
    verificationMethod: verifyOut.method,
    executionStatus: verifyOut.executionStatus,
    validationStatus: verifyOut.validationStatus,
    evidenceSummary: verifyOut.evidenceSummary,
    evidenceItems: verifyOut.evidenceItems,
    usedRawArtifacts: verifyOut.usedRawArtifacts,
    taskProgress: verifyOut.taskProgress,
    stoppedEarlyReason: actOut.stoppedEarlyReason,
    failureType: classification.failureType,
    blockedTargets: classification.blockedTargets,
    stateUpdates,
    fullStepText,
    stepRecord: {
      step: stepNumber,
      executionContract,
      outcome: verifyOut.passed ? "success" : "failed",
      summary: verifyOut.summary,
      newFacts,
      artifacts,
      toolSuccessCount,
      toolFailureCount,
      verificationMethod: verifyOut.method,
      executionStatus: verifyOut.executionStatus,
      validationStatus: verifyOut.validationStatus,
      evidenceSummary: verifyOut.evidenceSummary,
      evidenceItems: verifyOut.evidenceItems,
      stoppedEarlyReason: actOut.stoppedEarlyReason,
      failureType: classification.failureType,
      blockedTargets: classification.blockedTargets ?? [],
      act: {
        toolCalls: actOut.toolCalls.map((call) => ({
          tool: call.tool,
          input: call.input,
          output: call.output,
          outputStorage: call.outputStorage,
          rawOutputPath: call.rawOutputPath,
          rawOutputChars: call.rawOutputChars,
          outputTruncated: call.outputTruncated,
          error: call.error,
          meta: call.meta,
        })),
        finalText: actOut.finalText,
      },
    },
  };
}

// --- Phase 1: Act ---

async function act(
  deps: ExecutorDeps,
  directive: StepDirective,
  stepNumber: number,
  runPath: string,
): Promise<ActOutput> {
  const explicitToolPlan = Array.isArray(directive.tool_plan) ? directive.tool_plan : [];
  if (explicitToolPlan.length === 0) {
    return actWithLegacyAutonomy(deps, directive, stepNumber, runPath);
  }

  if (directive.execution_mode === "dependent" && explicitToolPlan.length > 1) {
    return finalizeActOutput(
      deps,
      directive,
      [],
      "planned_call_failed",
      "Dependent steps may contain exactly one tool call.",
    );
  }

  const maxTotalCalls = directive.execution_mode === "dependent"
    ? 1
    : Math.max(1, deps.config.maxTotalToolCallsPerStep);
  const plannedCalls = explicitToolPlan.slice(0, maxTotalCalls);
  const toolCalls: ActToolCallRecord[] = [];
  if (plannedCalls.length === 0) {
    return finalizeActOutput(deps, directive, toolCalls, "no_valid_tool_calls");
  }

  if (explicitToolPlan.length > maxTotalCalls) {
    return finalizeActOutput(
      deps,
      directive,
      [],
      "max_total_tool_calls_reached",
      `Tool plan exceeded the per-step execution limit of ${maxTotalCalls} call(s).`,
    );
  }

  const maxCallsPerBatch = directive.execution_mode === "independent" ? 2 : 1;

  for (let index = 0; index < plannedCalls.length; index += maxCallsPerBatch) {
    const batch = plannedCalls.slice(index, index + maxCallsPerBatch);
    const batchResults = await Promise.all(
      batch.map((call, batchIndex) => executePlannedCall(deps, call, stepNumber, runPath, index + batchIndex + 1)),
    );
    toolCalls.push(...batchResults);

    if (batchResults.some((record) => !!record.error)) {
      return finalizeActOutput(deps, directive, toolCalls, "planned_call_failed");
    }
  }

  return finalizeActOutput(deps, directive, toolCalls);
}

function finalizeActOutput(
  deps: ExecutorDeps,
  directive: StepDirective,
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason?: NonNullable<ActOutput["stoppedEarlyReason"]>,
  fallbackText?: string,
): ActOutput {
  const finalText = toolCalls.length > 0
    ? buildFallbackActSummary(directive, toolCalls, stoppedEarlyReason)
    : (fallbackText ?? buildNoToolActSummary(directive, stoppedEarlyReason));

  return {
    toolCalls,
    finalText,
    stoppedEarlyReason,
  };
}

function buildNoToolActSummary(
  directive: StepDirective,
  stoppedEarlyReason?: NonNullable<ActOutput["stoppedEarlyReason"]>,
): string {
  const executionContract = getDirectiveExecutionContract(directive);
  if (!stoppedEarlyReason) {
    return `Execution contract "${executionContract}" produced no tool calls.`;
  }
  return `Execution contract "${executionContract}" stopped before running tools due to ${stoppedEarlyReason}.`;
}

async function normalizeToolCallRecord(
  deps: ExecutorDeps,
  record: ActToolCallRecord,
  runPath: string,
  stepNumber: number,
  stepId: number,
): Promise<ActToolCallRecord> {
  const normalizedOutput = typeof record.output === "string" ? record.output : String(record.output ?? "");
  const rawOutputChars = normalizedOutput.length;
  if (rawOutputChars <= deps.config.maxInlineActOutputChars) {
    return {
      ...record,
      output: normalizedOutput,
      outputStorage: "inline",
      rawOutputChars,
      outputTruncated: false,
    };
  }

  const rawOutputPath = buildRawOutputArtifactPath(stepNumber, stepId);
  await writeStepArtifactText(runPath, rawOutputPath, normalizedOutput);

  return {
    ...record,
    output: buildOutputPreview(normalizedOutput, deps.config.maxInlineActOutputChars),
    outputStorage: "raw_file",
    rawOutputPath,
    rawOutputChars,
    outputTruncated: true,
  };
}

function buildRawOutputArtifactPath(stepNumber: number, stepId: number): string {
  const pad = String(stepNumber).padStart(3, "0");
  const callPad = String(stepId).padStart(2, "0");
  return `steps/${pad}-call-${callPad}-raw.txt`;
}

function buildOutputPreview(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }

  const marker = "\n...[truncated]...\n";
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.max(1, Math.floor(available * 0.7));
  const tailChars = Math.max(1, available - headChars);
  return `${output.slice(0, headChars)}${marker}${output.slice(output.length - tailChars)}`;
}

function collectActArtifacts(toolCalls: ActToolCallRecord[]): string[] {
  return toolCalls
    .map((call) => call.rawOutputPath)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

async function executeSingleTool(
  deps: ExecutorDeps,
  toolName: string,
  input: unknown,
  stepNumber: number,
  stepId: number,
): Promise<ActToolCallRecord> {
  if (!deps.toolExecutor) {
    return { tool: toolName, input, output: "", error: `No tool executor available` };
  }

  const validation = deps.toolExecutor.validate(toolName, input, {
    clientId: deps.clientId,
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepNumber,
  });
  if (!validation.valid) {
    const schema = "schema" in validation ? validation.schema : undefined;
    return {
      tool: toolName,
      input,
      output: "",
      error: formatValidationError(toolName, validation.error, schema),
    };
  }

  const result = await deps.toolExecutor.execute(toolName, input, {
    clientId: deps.clientId,
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepNumber,
  });
  if (!result.ok) {
    return { tool: toolName, input, output: result.output ?? "", error: result.error ?? "Tool execution failed", meta: result.meta };
  }

  return { tool: toolName, input, output: result.output ?? "", meta: result.meta };
}

async function executePlannedCall(
  deps: ExecutorDeps,
  plannedCall: StepPlanCall,
  stepNumber: number,
  runPath: string,
  stepId: number,
): Promise<ActToolCallRecord> {
  const firstAttempt = await normalizeToolCallRecord(
    deps,
    await executeSingleTool(deps, plannedCall.tool, plannedCall.input, stepNumber, stepId),
    runPath,
    stepNumber,
    stepId,
  );
  recordPlannedToolResult(deps, plannedCall, firstAttempt, stepId);
  if (!firstAttempt.error) {
    return firstAttempt;
  }

  if (
    plannedCall.retry_policy !== "same_call_once_on_timeout"
    || !isTimeoutError(firstAttempt.error)
  ) {
    return firstAttempt;
  }

  const retryAttempt = await normalizeToolCallRecord(
    deps,
    await executeSingleTool(deps, plannedCall.tool, plannedCall.input, stepNumber, stepId),
    runPath,
    stepNumber,
    stepId,
  );
  recordPlannedToolResult(deps, plannedCall, retryAttempt, stepId, "retry-1");
  if (!retryAttempt.error) {
    return retryAttempt;
  }

  return {
    ...retryAttempt,
    error: `Retry policy exhausted for '${plannedCall.tool}': ${retryAttempt.error}`,
  };
}

function recordPlannedToolResult(
  deps: ExecutorDeps,
  plannedCall: StepPlanCall,
  record: ActToolCallRecord,
  stepId: number,
  suffix = "initial",
): void {
  const toolCallId = `plan-${stepId}-${suffix}`;
  deps.sessionMemory.recordToolCall(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepId,
    toolCallId,
    toolName: plannedCall.tool,
    args: plannedCall.input,
  });

  deps.sessionMemory.recordToolResult(deps.clientId, {
    runId: deps.runHandle.runId,
    sessionId: deps.runHandle.sessionId,
    stepId,
    toolCallId,
    toolName: plannedCall.tool,
    status: record.error ? "failed" : "success",
    output: record.output,
    errorMessage: record.error,
  });
}

function isTimeoutError(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes("timeout") || normalized.includes("timed out");
}

// --- Phase 2: Verify ---

async function verify(
  deps: ExecutorDeps,
  actOut: ActOutput,
  successCriteria: string,
  runPath: string,
): Promise<VerifyOutput> {
  const executionStatus = deriveExecutionStatus(actOut);
  const gateResult = checkVerificationGates(actOut);
  const stepResult = gateResult
    ?? await verifyStepWithLlm(deps, actOut, successCriteria, executionStatus, runPath);
  const mergedFacts = buildStepNewFacts(actOut.toolCalls, stepResult.newFacts);
  const taskResult = await updateTaskProgress(
    deps,
    {
      outcome: stepResult.passed ? "success" : "failed",
      summary: stepResult.summary,
      evidenceItems: stepResult.evidenceItems,
      taskFacts: mergedFacts,
      artifacts: stepResult.artifacts,
    },
  );

  return {
    ...stepResult,
    taskProgress: taskResult,
  };
}

// --- Helpers ---

function buildToolSchemas(deps: ExecutorDeps): LlmToolSchema[] {
  const allDefs = deps.toolDefinitions.length > 0
    ? deps.toolDefinitions
    : (deps.toolExecutor?.definitions() ?? []);

  return allDefs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema ?? { type: "object", properties: {} },
  }));
}

function prioritizeCallsByHint<T extends { name: string }>(calls: T[], toolsHint: string[]): T[] {
  if (toolsHint.length === 0) return calls;

  const priority = new Map<string, number>();
  toolsHint.forEach((tool, idx) => priority.set(tool, idx));

  return [...calls].sort((a, b) => {
    const aRank = priority.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bRank = priority.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });
}

function buildFailureFingerprint(toolName: string, input: unknown, error: string): string {
  const normalizedError = error.replace(/\s+/g, " ").trim().toLowerCase();
  const callSignature = buildCallSignature(toolName, input);
  return `${callSignature}::${normalizedError}`;
}

function buildCallSignature(toolName: string, input: unknown): string {
  let normalizedInput = "";
  try {
    normalizedInput = JSON.stringify(input ?? {});
  } catch {
    normalizedInput = String(input);
  }
  return `${toolName}::${normalizedInput}`;
}

function buildActPrompt(directive: StepDirective, availableToolNames: string[]): string {
  const preferredTools = (directive.tools_hint ?? []).length > 0
    ? (directive.tools_hint ?? []).join(", ")
    : "none";
  const availableTools = availableToolNames.length > 0
    ? availableToolNames.join(", ")
    : "none";

  return `Execute this step:
Intent: ${getDirectiveExecutionContract(directive)}
Context: ${directive.context}
Preferred tools: ${preferredTools}
Available tools: ${availableTools}

Prefer the suggested tools first, but you may use any available tool if it is better for progress or recovery.
If a tool call fails, do not repeat the same tool call with identical input in this step.
If the same tool fails twice in this step, switch to a different available tool or a materially different strategy.
When done, respond with a text summary.`;
}

function buildForcedSummaryPrompt(
  directive: StepDirective,
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason: NonNullable<ActOutput["stoppedEarlyReason"]>,
): string {
  const toolFacts = toolCalls.map((call, index) => {
    const status = call.error ? "failed" : "succeeded";
    const detail = call.error
      ? `error=${summarizeForPrompt(call.error)}`
      : `output=${summarizeForPrompt(call.output)}`;
    return `- ${index + 1}. ${call.tool} ${status}; ${detail}`;
  }).join("\n");

  return `Execution for this step has stopped because of ${stoppedEarlyReason}.
Do not call any tools.
Write a concise 1-3 sentence summary of what happened in this step using only the existing tool results.
Be explicit about whether the step made progress, partially succeeded, or failed.

Step intent: ${getDirectiveExecutionContract(directive)}
Success criteria: ${directive.success_criteria}
Tool results:
${toolFacts}`;
}

function buildFallbackActSummary(
  directive: StepDirective,
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason?: NonNullable<ActOutput["stoppedEarlyReason"]>,
): string {
  const successfulCalls = toolCalls.filter((call) => !call.error);
  const failedCalls = toolCalls.filter((call) => !!call.error);
  const details: string[] = [];

  if (successfulCalls.length > 0) {
    const successPreview = successfulCalls
      .slice(0, 2)
      .map((call) => `${call.tool}: ${summarizeForPrompt(call.output)}`)
      .join("; ");
    details.push(`Successful results: ${successPreview}`);
  }

  if (failedCalls.length > 0) {
    const failurePreview = failedCalls
      .slice(0, 2)
      .map((call) => `${call.tool}: ${summarizeForPrompt(call.error ?? "")}`)
      .join("; ");
    details.push(`Failures: ${failurePreview}`);
  }

  const executionContract = getDirectiveExecutionContract(directive);
  const statusPrefix = stoppedEarlyReason
    ? `Execution contract "${executionContract}" stopped due to ${stoppedEarlyReason}.`
    : `Execution contract "${executionContract}" completed.`;
  const base = `${statusPrefix} ${toolCalls.length} tool call(s) ran (${successfulCalls.length} succeeded, ${failedCalls.length} failed).`;
  return details.length > 0 ? `${base} ${details.join(" ")}` : base;
}

function selectCallsForTurn<T extends { name: string; input: unknown }>(
  calls: T[],
  maxCallsPerTurn: number,
  failedCallSignatures: Set<string>,
  blockedTools: Set<string>,
): T[] {
  if (calls.length === 0) return [];

  const executable = calls.filter(
    (call) => !getBlockedCallReason(call.name, call.input, failedCallSignatures, blockedTools),
  );

  if (executable.length > 0) {
    return executable.slice(0, maxCallsPerTurn);
  }

  return calls.slice(0, maxCallsPerTurn);
}

function getBlockedCallReason(
  toolName: string,
  input: unknown,
  failedCallSignatures: Set<string>,
  blockedTools: Set<string>,
): string | undefined {
  if (blockedTools.has(toolName)) {
    return `Tool '${toolName}' already failed twice in this step. Try a different available tool or strategy.`;
  }

  if (failedCallSignatures.has(buildCallSignature(toolName, input))) {
    return `Repeat blocked: tool '${toolName}' with the same input already failed in this step. Try different parameters or a different tool.`;
  }

  return undefined;
}

function buildRecoveryGuidance(
  toolName: string,
  input: unknown,
  error: string,
  toolFailureCount: number,
  hintedTools: string[],
  availableToolNames: string[],
): string {
  const failureKind = classifyActFailure(error);
  const preferredTools = hintedTools.length > 0 ? hintedTools.join(", ") : "none";
  const availableTools = availableToolNames.length > 0 ? availableToolNames.join(", ") : "none";
  const sameToolRule = toolFailureCount >= 2
    ? `Tool '${toolName}' has already failed ${toolFailureCount} times in this step. Do not use it again in this step unless you truly have no better option.`
    : `You may still use '${toolName}' only with materially different input if that can plausibly recover.`;

  return `Recovery guidance:
- Last failed tool: ${toolName}
- Failed input: ${summarizeForPrompt(input)}
- Error: ${error}
- Failure type: ${failureKind}
- Do not repeat the same tool call with identical input in this step.
- ${sameToolRule}
- Preferred tools remain: ${preferredTools}
- Available tools you may use: ${availableTools}
- Recovery suggestion: ${buildRecoverySuggestion(failureKind, toolName)}`;
}

function classifyActFailure(error: string): "permission" | "missing_path" | "validation_error" | "no_progress" | "tool_error" {
  const normalized = error.toLowerCase();
  if (normalized.includes("validation failed")) return "validation_error";
  if (normalized.includes("permission denied") || normalized.includes("eacces")) return "permission";
  if (normalized.includes("no such file") || normalized.includes("does not exist") || normalized.includes("enoent")) {
    return "missing_path";
  }
  if (normalized.includes("not found") || normalized.includes("no matches") || normalized.includes("returned no")) {
    return "no_progress";
  }
  return "tool_error";
}

function buildRecoverySuggestion(
  failureKind: "permission" | "missing_path" | "validation_error" | "no_progress" | "tool_error",
  toolName: string,
): string {
  switch (failureKind) {
    case "permission":
      return `Avoid the same blocked target/path. Use a different tool or route that does not require the denied access.`;
    case "missing_path":
      return `Discover the correct path or resource first before retrying.`;
    case "validation_error":
      return `Repair the tool arguments to match the schema before retrying '${toolName}'.`;
    case "no_progress":
      return `Broaden or change the search strategy instead of repeating the same attempt.`;
    default:
      return `Try a different tool or materially different parameters instead of repeating the failed call.`;
  }
}

function getDirectiveExecutionContract(directive: StepDirective): string {
  return directive.execution_contract ?? directive.intent ?? "";
}

async function actWithLegacyAutonomy(
  deps: ExecutorDeps,
  directive: StepDirective,
  stepNumber: number,
  runPath: string,
): Promise<ActOutput> {
  const toolSchemas = buildToolSchemas(deps);
  const availableToolNames = new Set(toolSchemas.map((schema) => schema.name));
  const toolCalls: ActToolCallRecord[] = [];
  const failedCallSignatures = new Set<string>();
  const blockedRetryCounts = new Map<string, number>();
  const repeatedFailureCounts = new Map<string, number>();
  const toolFailureCounts = new Map<string, number>();
  const blockedTools = new Set<string>();
  const maxCallsPerTurn = directive.execution_mode === "independent" ? 2 : 1;
  const maxTotalCalls = directive.execution_mode === "dependent"
    ? 1
    : Math.max(1, deps.config.maxTotalToolCallsPerStep);
  let executedCalls = 0;

  const prompt = buildActPrompt(directive, toolSchemas.map((tool) => tool.name));
  const messages: LlmMessage[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < deps.config.maxToolCallsPerStep; i++) {
    const turn = await deps.provider.generateTurn({
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    });

    if (turn.type === "assistant") {
      return {
        toolCalls,
        finalText: turn.content,
        stoppedEarlyReason: "assistant_returned",
      };
    }

    const candidateCalls = prioritizeCallsByHint(turn.calls, directive.tools_hint ?? [])
      .filter((call) => availableToolNames.has(call.name));

    const orderedCalls = selectCallsForTurn(
      candidateCalls,
      maxCallsPerTurn,
      failedCallSignatures,
      blockedTools,
    );

    if (orderedCalls.length === 0) {
      return await finalizeLegacyActOutput(
        deps,
        directive,
        messages,
        toolCalls,
        "no_valid_tool_calls",
      );
    }

    for (const call of orderedCalls) {
      if (executedCalls >= maxTotalCalls) {
        return await finalizeLegacyActOutput(
          deps,
          directive,
          messages,
          toolCalls,
          "max_total_tool_calls_reached",
        );
      }

      const callSignature = buildCallSignature(call.name, call.input);
      const blockedReason = getBlockedCallReason(call.name, call.input, failedCallSignatures, blockedTools);
      const rawRecord = blockedReason
        ? { tool: call.name, input: call.input, output: "", error: blockedReason }
        : await executeSingleTool(deps, call.name, call.input, stepNumber, i + 1);
      const record = await normalizeToolCallRecord(
        deps,
        rawRecord,
        runPath,
        stepNumber,
        i + 1,
      );
      toolCalls.push(record);
      executedCalls++;

      deps.sessionMemory.recordToolCall(deps.clientId, {
        runId: deps.runHandle.runId,
        sessionId: deps.runHandle.sessionId,
        stepId: i + 1,
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });

      deps.sessionMemory.recordToolResult(deps.clientId, {
        runId: deps.runHandle.runId,
        sessionId: deps.runHandle.sessionId,
        stepId: i + 1,
        toolCallId: call.id,
        toolName: call.name,
        status: record.error ? "failed" : "success",
        output: record.output,
        errorMessage: record.error,
      });

      messages.push({ role: "assistant_tool_calls", calls: [call] });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: record.error
          ? formatToolResult(call.name, { ok: false, error: record.error })
          : formatToolResult(call.name, { ok: true, output: record.output }),
      });

      if (record.error) {
        const fingerprint = buildFailureFingerprint(call.name, call.input, record.error);
        const repeatedCount = (repeatedFailureCounts.get(fingerprint) ?? 0) + 1;
        repeatedFailureCounts.set(fingerprint, repeatedCount);
        failedCallSignatures.add(callSignature);

        const toolFailureCount = (toolFailureCounts.get(call.name) ?? 0) + 1;
        toolFailureCounts.set(call.name, toolFailureCount);
        if (toolFailureCount >= 2) {
          blockedTools.add(call.name);
        }

        messages.push({
          role: "user",
          content: buildRecoveryGuidance(
            call.name,
            call.input,
            record.error,
            toolFailureCount,
            directive.tools_hint ?? [],
            toolSchemas.map((tool) => tool.name),
          ),
        });

        if (blockedReason) {
          const blockedRetryCount = (blockedRetryCounts.get(callSignature) ?? 0) + 1;
          blockedRetryCounts.set(callSignature, blockedRetryCount);
          if (blockedRetryCount >= 2) {
            return await finalizeLegacyActOutput(
              deps,
              directive,
              messages,
              toolCalls,
              "repeated_identical_failure",
            );
          }
        }

        if (repeatedCount >= 2) {
          return await finalizeLegacyActOutput(
            deps,
            directive,
            messages,
            toolCalls,
            "repeated_identical_failure",
          );
        }
      }
    }
  }

  return await finalizeLegacyActOutput(
    deps,
    directive,
    messages,
    toolCalls,
    toolCalls.length > 0 ? "max_act_turns_reached" : "no_valid_tool_calls",
  );
}

async function finalizeLegacyActOutput(
  deps: ExecutorDeps,
  directive: StepDirective,
  messages: LlmMessage[],
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason: NonNullable<ActOutput["stoppedEarlyReason"]>,
): Promise<ActOutput> {
  const finalText = toolCalls.length > 0
    ? await requestForcedStepSummary(deps, directive, messages, toolCalls, stoppedEarlyReason)
    : "";

  return {
    toolCalls,
    finalText,
    stoppedEarlyReason,
  };
}

async function requestForcedStepSummary(
  deps: ExecutorDeps,
  directive: StepDirective,
  messages: LlmMessage[],
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason: NonNullable<ActOutput["stoppedEarlyReason"]>,
): Promise<string> {
  const prompt = buildForcedSummaryPrompt(directive, toolCalls, stoppedEarlyReason);

  try {
    const turn = await deps.provider.generateTurn({
      messages: [...messages, { role: "user", content: prompt }],
    });
    if (turn.type === "assistant" && turn.content.trim().length > 0) {
      return turn.content.trim();
    }
  } catch {
    // Fall back to a deterministic summary built from tool results.
  }

  return buildFallbackActSummary(directive, toolCalls, stoppedEarlyReason);
}

function parseJSON<T>(text: string): T {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }
  return JSON.parse(jsonStr) as T;
}

async function verifyStepWithLlm(
  deps: ExecutorDeps,
  actOut: ActOutput,
  successCriteria: string,
  executionStatus: VerificationExecutionStatus,
  runPath: string,
): Promise<VerifyOutput> {
  const verificationPayload = await buildVerificationPayload(
    actOut,
    runPath,
    deps.config.maxVerifyArtifactChars,
  );
  const actSummary = JSON.stringify(verificationPayload);

  const prompt = `Verify whether this step succeeded.

Execution status: ${executionStatus}
Action output: ${actSummary}
Success criteria: ${successCriteria}

Respond with JSON:
{
  "passed": true|false,
  "summary": "...",
  "evidenceSummary": "...",
  "evidenceItems": ["..."],
  "newFacts": ["..."],
  "artifacts": ["..."]
}`;

  const turn = await deps.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  const text = turn.type === "assistant" ? turn.content : "";
  try {
    const parsed = parseJSON<Record<string, unknown>>(text);
    const artifacts = Array.isArray(parsed["artifacts"]) ? (parsed["artifacts"] as unknown[]).map(String) : [];
    const evidenceSummary = String(parsed["evidenceSummary"] ?? "");
    const summary = String(parsed["summary"] ?? "").trim()
      || evidenceSummary.trim()
      || actOut.finalText.slice(0, 500)
      || (parsed["passed"] === true ? "Step passed verification." : "Step failed verification.");
    return {
      passed: parsed["passed"] === true,
      method: "llm",
      executionStatus,
      validationStatus: parsed["passed"] === true ? "passed" : "failed",
      summary,
      evidenceSummary,
      evidenceItems: Array.isArray(parsed["evidenceItems"])
        ? (parsed["evidenceItems"] as unknown[]).map(String)
        : [],
      newFacts: Array.isArray(parsed["newFacts"]) ? (parsed["newFacts"] as unknown[]).map(String) : [],
      artifacts: [...new Set([...artifacts, ...verificationPayload.usedRawArtifacts])],
      usedRawArtifacts: verificationPayload.usedRawArtifacts,
    };
  } catch {
    return {
      passed: false,
      method: "llm",
      executionStatus,
      validationStatus: "failed",
      summary: "Verification failed because the validator response could not be parsed.",
      evidenceSummary: `Failed to parse verify response: ${text}`,
      evidenceItems: [],
      newFacts: [],
      artifacts: [...verificationPayload.usedRawArtifacts],
      usedRawArtifacts: verificationPayload.usedRawArtifacts,
    };
  }
}

async function updateTaskProgress(
  deps: ExecutorDeps,
  latestStep: {
    outcome: "success" | "failed";
    summary: string;
    evidenceItems: string[];
    taskFacts: string[];
    artifacts: string[];
  },
): Promise<TaskProgressState> {
  const effectiveSummary = latestStep.summary.trim().length > 0
    ? latestStep.summary
    : deps.taskContext.latestSuccessfulStep.summary;
  const effectiveFacts = latestStep.taskFacts.length > 0
    ? latestStep.taskFacts
    : deps.taskContext.latestSuccessfulStep.taskFacts;
  const effectiveEvidenceItems = latestStep.evidenceItems.length > 0
    ? latestStep.evidenceItems
    : deps.taskContext.latestSuccessfulStep.evidenceItems;
  const latestEvidence = effectiveEvidenceItems.length > 0
    ? effectiveEvidenceItems.map((item) => `- ${item}`).join("\n")
    : "- none";
  const latestFacts = effectiveFacts.length > 0
    ? effectiveFacts.map((fact) => `- ${fact}`).join("\n")
    : "- none";
  const latestArtifacts = latestStep.artifacts.length > 0
    ? latestStep.artifacts.map((artifact) => `- ${artifact}`).join("\n")
    : "- none";
  const previousTaskProgress = formatTaskProgressForPrompt(deps.taskContext.previousTaskProgress);
  const recentSuccessfulSteps = formatTaskProgressDigests(deps.taskContext.recentSuccessfulSteps, false);
  const recentFailedSteps = formatTaskProgressDigests(deps.taskContext.recentFailedSteps, true);

  const inputBlock = deps.taskContext.inputKind === "system_event" && deps.taskContext.systemEvent
    ? [
      "Assess overall task progress after the latest completed step.",
      "",
      "Input kind: system_event",
      `Origin source: ${deps.taskContext.originSource ?? deps.taskContext.systemEvent.source}`,
      `Intent kind: ${deps.taskContext.systemEventIntentKind ?? deps.taskContext.systemEvent.intent?.kind ?? "unknown"}`,
      ...(deps.taskContext.systemEventRequestedAction ? [`Requested action: ${deps.taskContext.systemEventRequestedAction}`] : []),
      `Created by: ${deps.taskContext.systemEventCreatedBy ?? deps.taskContext.systemEvent.intent?.createdBy ?? "unknown"}`,
      ...(deps.taskContext.handlingMode ? [`Handling mode: ${deps.taskContext.handlingMode}`] : []),
      ...(typeof deps.taskContext.approvalRequired === "boolean" ? [`Approval required: ${deps.taskContext.approvalRequired ? "yes" : "no"}`] : []),
      ...(deps.taskContext.approvalState ? [`Approval state: ${deps.taskContext.approvalState}`] : []),
      `System event summary: ${deps.taskContext.userMessage}`,
      `System event payload: ${JSON.stringify({
        source: deps.taskContext.systemEvent.source,
        eventName: deps.taskContext.systemEvent.eventName,
        receivedAt: deps.taskContext.systemEvent.receivedAt,
        payload: deps.taskContext.systemEvent.payload,
      })}`,
    ].join("\n")
    : `Assess overall task progress after the latest completed step.

User message: ${deps.taskContext.userMessage}`;

  const prompt = `${inputBlock}
Goal contract:
- objective: ${deps.taskContext.goal.objective || "(none)"}
- done_when: ${formatPromptList(deps.taskContext.goal.done_when)}
- required_evidence: ${formatPromptList(deps.taskContext.goal.required_evidence)}
- ask_user_when: ${formatPromptList(deps.taskContext.goal.ask_user_when)}
- stop_when_no_progress: ${formatPromptList(deps.taskContext.goal.stop_when_no_progress)}
Current task progress status: ${deps.taskContext.previousTaskProgress.status}
Current approach: ${deps.taskContext.approach || "(none)"}
Previous task progress:
${previousTaskProgress}
Latest completed step outcome: ${latestStep.outcome}
Latest completed step summary: ${effectiveSummary || "(none)"}
Latest step evidence:
${latestEvidence}
Latest step facts:
${latestFacts}
Latest step artifacts:
${latestArtifacts}
Recent successful steps:
${recentSuccessfulSteps}
Recent failed steps:
${recentFailedSteps}

Update the task progress using only these values.
- Keep the output compact, cumulative, and task-facing.
- This stage summarizes overall task state only; do not plan the next step.
- completedMilestones should capture stable achieved outcomes, max 6.
- openWork should capture the most important remaining work, max 5.
- blockers should capture active obstacles only, max 4.
- keyFacts should contain semantic facts only, max 8.
- evidence should contain the strongest supporting evidence only, max 6.
- currentFocus should state the main next area of work in one short sentence.
- If status is "needs_user_input", set userInputNeeded.

Respond with JSON:
{ "status": "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input", "progressSummary": "...", "currentFocus": "...", "completedMilestones": ["..."], "openWork": ["..."], "blockers": ["..."], "keyFacts": ["..."], "evidence": ["..."], "userInputNeeded": "optional" }`;

  const turn = await deps.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  const text = turn.type === "assistant" ? turn.content : "";
  try {
    const parsed = parseJSON<Record<string, unknown>>(text);
    return normalizeTaskProgressState(parsed, deps.taskContext.previousTaskProgress, {
      summary: effectiveSummary,
      evidenceItems: effectiveEvidenceItems,
      taskFacts: effectiveFacts,
    });
  } catch {
    return {
      ...deps.taskContext.previousTaskProgress,
      status: deps.taskContext.previousTaskProgress.status,
      progressSummary: deps.taskContext.previousTaskProgress.progressSummary.trim().length > 0
        ? deps.taskContext.previousTaskProgress.progressSummary
        : `Failed to parse task progress response: ${text}`,
      currentFocus: deps.taskContext.previousTaskProgress.currentFocus,
      completedMilestones: deps.taskContext.previousTaskProgress.completedMilestones,
      openWork: deps.taskContext.previousTaskProgress.openWork,
      blockers: deps.taskContext.previousTaskProgress.blockers,
      keyFacts: deps.taskContext.previousTaskProgress.keyFacts,
      evidence: deps.taskContext.previousTaskProgress.evidence,
      userInputNeeded: deps.taskContext.previousTaskProgress.userInputNeeded,
    };
  }
}

async function buildVerificationPayload(
  actOut: ActOutput,
  runPath: string,
  maxVerifyArtifactChars: number,
): Promise<{
  toolCalls: Array<Record<string, unknown>>;
  finalText: string;
  usedRawArtifacts: string[];
}> {
  const views = await Promise.all(actOut.toolCalls.map(async (call) => {
    const verificationView = await buildVerificationView(call, runPath, maxVerifyArtifactChars);
    return {
      verificationView,
      callPayload: {
      tool: call.tool,
      input: summarizeForPrompt(call.input),
      output: verificationView.output,
      outputSource: verificationView.outputSource,
      rawOutputPath: verificationView.rawOutputPath,
      rawOutputChars: call.rawOutputChars ?? 0,
      outputTruncated: verificationView.outputTruncated,
      error: call.error ?? "",
      },
    };
  }));
  const usedRawArtifacts = views
    .map(({ verificationView }) => verificationView.usedRawArtifact ? verificationView.rawOutputPath : undefined)
    .filter((path): path is string => typeof path === "string" && path.length > 0);

  return {
    toolCalls: views.map(({ callPayload }) => callPayload),
    finalText: actOut.finalText.slice(0, 500),
    usedRawArtifacts,
  };
}

async function buildVerificationView(
  call: ActToolCallRecord,
  runPath: string,
  maxVerifyArtifactChars: number,
): Promise<{
  output: string;
  outputSource: "inline" | "raw_file";
  rawOutputPath?: string;
  outputTruncated: boolean;
  usedRawArtifact: boolean;
}> {
  if (call.outputStorage !== "raw_file" || !call.rawOutputPath) {
    return {
      output: call.output,
      outputSource: "inline",
      rawOutputPath: call.rawOutputPath,
      outputTruncated: call.outputTruncated === true,
      usedRawArtifact: false,
    };
  }

  try {
    const rawOutput = await readFile(join(runPath, call.rawOutputPath), "utf-8");
    return {
      output: rawOutput.length <= maxVerifyArtifactChars
        ? rawOutput
        : buildOutputPreview(rawOutput, maxVerifyArtifactChars),
      outputSource: "raw_file",
      rawOutputPath: call.rawOutputPath,
      outputTruncated: rawOutput.length > maxVerifyArtifactChars,
      usedRawArtifact: true,
    };
  } catch (error) {
    const fallbackError = error instanceof Error ? error.message : String(error);
    return {
      output: `${call.output}\n[raw output unavailable: ${fallbackError}]`.trim(),
      outputSource: "inline",
      rawOutputPath: call.rawOutputPath,
      outputTruncated: true,
      usedRawArtifact: false,
    };
  }
}

function normalizeTaskStatus(value: unknown): TaskStatus {
  switch (value) {
    case "done":
    case "likely_done":
    case "blocked":
    case "needs_user_input":
      return value;
    default:
      return "not_done";
  }
}

function normalizeTaskProgressState(
  parsed: Record<string, unknown>,
  previous: TaskProgressState,
  latestSuccessfulStep: {
    summary: string;
    evidenceItems: string[];
    taskFacts: string[];
  },
): TaskProgressState {
  const status = normalizeTaskStatus(parsed["status"]);
  const progressSummary = String(parsed["progressSummary"] ?? "").trim()
    || latestSuccessfulStep.summary
    || previous.progressSummary;
  const keyFacts = uniqueStrings([
    ...readStringArray(parsed["keyFacts"]),
    ...latestSuccessfulStep.taskFacts,
  ]).slice(0, 8);
  const evidence = uniqueStrings([
    ...readStringArray(parsed["evidence"]),
    ...latestSuccessfulStep.evidenceItems,
  ]).slice(0, 6);
  const userInputNeeded = String(parsed["userInputNeeded"] ?? "").trim()
    || (status === "needs_user_input" ? previous.userInputNeeded ?? "" : "");

  return {
    status,
    progressSummary,
    currentFocus: String(parsed["currentFocus"] ?? "").trim() || previous.currentFocus,
    completedMilestones: normalizeProgressList(parsed["completedMilestones"], previous.completedMilestones, 6),
    openWork: normalizeProgressList(parsed["openWork"], previous.openWork, 5),
    blockers: normalizeProgressList(parsed["blockers"], previous.blockers, 4),
    keyFacts,
    evidence,
    userInputNeeded: userInputNeeded.length > 0 ? userInputNeeded : undefined,
  };
}

function formatTaskProgressForPrompt(taskProgress: TaskProgressState): string {
  const lines = [
    `- status: ${taskProgress.status}`,
    `- progressSummary: ${taskProgress.progressSummary || "(none)"}`,
    `- currentFocus: ${taskProgress.currentFocus || "(none)"}`,
    `- completedMilestones: ${(taskProgress.completedMilestones ?? []).length > 0 ? (taskProgress.completedMilestones ?? []).join("; ") : "(none)"}`,
    `- openWork: ${(taskProgress.openWork ?? []).length > 0 ? (taskProgress.openWork ?? []).join("; ") : "(none)"}`,
    `- blockers: ${(taskProgress.blockers ?? []).length > 0 ? (taskProgress.blockers ?? []).join("; ") : "(none)"}`,
    `- keyFacts: ${taskProgress.keyFacts.length > 0 ? taskProgress.keyFacts.join("; ") : "(none)"}`,
    `- evidence: ${taskProgress.evidence.length > 0 ? taskProgress.evidence.join("; ") : "(none)"}`,
  ];
  if (taskProgress.userInputNeeded) {
    lines.push(`- userInputNeeded: ${taskProgress.userInputNeeded}`);
  }
  return lines.join("\n");
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map(String).filter((item) => item.trim().length > 0) : [];
}

function normalizeProgressList(
  value: unknown,
  previous: string[] | undefined,
  limit: number,
): string[] {
  const next = readStringArray(value);
  if (next.length > 0) {
    return uniqueStrings(next).slice(0, limit);
  }
  return uniqueStrings(previous ?? []).slice(0, limit);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatTaskProgressDigests(
  steps: ExecutorDeps["taskContext"]["recentSuccessfulSteps"] | ExecutorDeps["taskContext"]["recentFailedSteps"] | undefined,
  includeFailureMeta: boolean,
): string {
  if (!steps || steps.length === 0) {
    return "- none";
  }
  return steps.map((step) => {
    let line = `- Step ${step.step}: ${step.executionContract || "(no contract)"} — ${step.summary || "(no summary)"}`;
    if (step.taskFacts.length > 0) {
      line += ` | facts=${step.taskFacts.slice(0, 3).join(" / ")}`;
    }
    if (includeFailureMeta && "failureType" in step && step.failureType) {
      line += ` | failureType=${step.failureType}`;
    }
    if (includeFailureMeta && "blockedTargets" in step && step.blockedTargets.length > 0) {
      line += ` | blocked=${step.blockedTargets.slice(0, 3).join(", ")}`;
    }
    return line;
  }).join("\n");
}

function summarizeForPrompt(value: unknown, maxLen = 220): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function formatPromptList(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "(none)";
}

function buildStepNewFacts(_toolCalls: ActToolCallRecord[], verifyFacts: string[]): string[] {
  return uniqueStrings(verifyFacts);
}

function buildStepStateUpdates(toolCalls: ActToolCallRecord[]): PreparedAttachmentStateUpdate[] {
  const updates: PreparedAttachmentStateUpdate[] = [];

  for (const call of toolCalls) {
    if (call.error) {
      continue;
    }
    const rawUpdates = call.meta?.["stateUpdates"];
    if (!Array.isArray(rawUpdates)) {
      continue;
    }
    for (const rawUpdate of rawUpdates) {
      const parsed = parsePreparedAttachmentStateUpdate(rawUpdate);
      if (parsed) {
        updates.push(parsed);
      }
    }
  }

  return dedupePreparedAttachmentStateUpdates(updates);
}

function parsePreparedAttachmentStateUpdate(value: unknown): PreparedAttachmentStateUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record["type"] === "restore_prepared_attachment") {
    const manifest = parseManagedDocumentManifest(record["manifest"]);
    const summary = parsePreparedAttachmentSummary(record["summary"]);
    if (manifest && summary) {
      return {
        type: "restore_prepared_attachment",
        manifest,
        summary,
      };
    }
    return null;
  }
  const preparedInputId = typeof record["preparedInputId"] === "string" ? record["preparedInputId"].trim() : "";
  if (!preparedInputId) {
    return null;
  }
  if (record["type"] === "mark_dataset_staged" && record["staged"] === true) {
    const stagingDbPath = typeof record["stagingDbPath"] === "string" && record["stagingDbPath"].trim().length > 0
      ? record["stagingDbPath"].trim()
      : undefined;
    const stagingTableName = typeof record["stagingTableName"] === "string" && record["stagingTableName"].trim().length > 0
      ? record["stagingTableName"].trim()
      : undefined;
    return {
      type: "mark_dataset_staged",
      preparedInputId,
      staged: true,
      ...(stagingDbPath ? { stagingDbPath } : {}),
      ...(stagingTableName ? { stagingTableName } : {}),
    };
  }
  if (record["type"] === "mark_document_indexed" && record["indexed"] === true) {
    return {
      type: "mark_document_indexed",
      preparedInputId,
      indexed: true,
    };
  }
  return null;
}

function dedupePreparedAttachmentStateUpdates(
  updates: PreparedAttachmentStateUpdate[],
): PreparedAttachmentStateUpdate[] {
  const latestByKey = new Map<string, PreparedAttachmentStateUpdate>();
  for (const update of updates) {
    const key = update.type === "restore_prepared_attachment"
      ? `${update.type}:${update.summary.preparedInputId}`
      : `${update.type}:${update.preparedInputId}`;
    latestByKey.set(key, update);
  }
  return [...latestByKey.values()];
}

function parseManagedDocumentManifest(value: unknown): ManagedDocumentManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required = ["documentId", "name", "displayName", "source", "originalPath", "storedPath", "kind", "sizeBytes", "checksum"];
  if (!required.every((field) => field in record)) return null;
  if (
    typeof record["documentId"] !== "string"
    || typeof record["name"] !== "string"
    || typeof record["displayName"] !== "string"
    || typeof record["source"] !== "string"
    || typeof record["originalPath"] !== "string"
    || typeof record["storedPath"] !== "string"
    || typeof record["kind"] !== "string"
    || typeof record["sizeBytes"] !== "number"
    || typeof record["checksum"] !== "string"
  ) {
    return null;
  }
  return record as unknown as ManagedDocumentManifest;
}

function parsePreparedAttachmentSummary(value: unknown): PreparedAttachmentSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const required = ["preparedInputId", "documentId", "displayName", "source", "kind", "mode", "sizeBytes", "checksum", "originalPath", "status", "warnings", "artifactPath"];
  if (!required.every((field) => field in record)) return null;
  if (
    typeof record["preparedInputId"] !== "string"
    || typeof record["documentId"] !== "string"
    || typeof record["displayName"] !== "string"
    || typeof record["source"] !== "string"
    || typeof record["kind"] !== "string"
    || typeof record["mode"] !== "string"
    || typeof record["sizeBytes"] !== "number"
    || typeof record["checksum"] !== "string"
    || typeof record["originalPath"] !== "string"
    || typeof record["status"] !== "string"
    || !Array.isArray(record["warnings"])
    || typeof record["artifactPath"] !== "string"
  ) {
    return null;
  }
  return record as unknown as PreparedAttachmentSummary;
}

// --- Failure Classifier ---

function classifyFailure(
  toolCalls: ActToolCallRecord[],
  evidence: string,
): { failureType: FailedApproach["failureType"]; blockedTargets: string[] } {
  const errors = toolCalls.map((c) => c.error ?? "").join(" ");
  const combined = (errors + " " + evidence).toLowerCase();

  const blockedTargets: string[] = [];
  const pathRe = /(?:scandir|open|access|stat) '([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(errors)) !== null) {
    if (m[1]) blockedTargets.push(m[1]);
  }

  if (/eacces|permission denied/.test(combined)) return { failureType: "permission", blockedTargets };
  if (/enoent|no such file|does not exist/.test(combined)) return { failureType: "missing_path", blockedTargets };
  if (/no match|not found|not present|returned no/.test(combined)) return { failureType: "no_progress", blockedTargets: [] };
  if (errors.trim().length > 0) return { failureType: "tool_error", blockedTargets };
  return { failureType: "verify_failed", blockedTargets: [] };
}
