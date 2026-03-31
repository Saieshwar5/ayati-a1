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
  PreparedAttachmentStateUpdate,
} from "./types.js";
import { writeStepMarkdown, formatActMarkdown, formatVerifyMarkdown } from "./state-persistence.js";
import { checkVerificationGates } from "./verification-gates.js";
import { formatToolResult, formatValidationError } from "./tool-helpers.js";
import type { ManagedDocumentManifest, PreparedAttachmentSummary } from "../documents/types.js";

export async function executeStep(
  deps: ExecutorDeps,
  directive: StepDirective,
  stepNumber: number,
  runPath: string,
): Promise<StepSummary> {
  const pad = String(stepNumber).padStart(3, "0");

  const actOut = await act(deps, directive);
  const actMarkdownPath = `steps/${pad}-act.md`;
  const verifyMarkdownPath = `steps/${pad}-verify.md`;

  writeStepMarkdown(runPath, actMarkdownPath, formatActMarkdown(actOut));

  const verifyOut = await verify(deps, actOut, directive.success_criteria, pad, runPath);
  writeStepMarkdown(runPath, verifyMarkdownPath, formatVerifyMarkdown(verifyOut, actOut.toolCalls));

  const artifacts = [...new Set([actMarkdownPath, verifyMarkdownPath, ...verifyOut.artifacts])];
  const newFacts = buildStepNewFacts(actOut.toolCalls, verifyOut.newFacts);
  const stateUpdates = buildStepStateUpdates(actOut.toolCalls);

  const classification = verifyOut.passed
    ? { failureType: undefined, blockedTargets: undefined }
    : classifyFailure(actOut.toolCalls, verifyOut.evidence);
  const toolSuccessCount = actOut.toolCalls.filter((call) => !call.error).length;
  const toolFailureCount = actOut.toolCalls.length - toolSuccessCount;

  return {
    step: stepNumber,
    intent: directive.intent,
    outcome: verifyOut.passed ? "success" : "failed",
    summary: actOut.finalText.slice(0, 500),
    newFacts,
    artifacts,
    toolSuccessCount,
    toolFailureCount,
    taskStatusAfter: verifyOut.taskStatusAfter,
    taskReason: verifyOut.taskReason,
    taskEvidence: verifyOut.taskEvidence,
    stoppedEarlyReason: actOut.stoppedEarlyReason,
    failureType: classification.failureType,
    blockedTargets: classification.blockedTargets,
    stateUpdates,
  };
}

// --- Phase 1: Act ---

async function act(
  deps: ExecutorDeps,
  directive: StepDirective,
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
  const maxTotalCalls = Math.max(1, deps.config.maxTotalToolCallsPerStep);
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

    const candidateCalls = prioritizeCallsByHint(turn.calls, directive.tools_hint)
      .filter((call) => availableToolNames.has(call.name));

    const orderedCalls = selectCallsForTurn(
      candidateCalls,
      maxCallsPerTurn,
      failedCallSignatures,
      blockedTools,
    );

    if (orderedCalls.length === 0) {
      return await finalizeActOutput(
        deps,
        directive,
        messages,
        toolCalls,
        "no_valid_tool_calls",
      );
    }

    for (const call of orderedCalls) {
      if (executedCalls >= maxTotalCalls) {
        return await finalizeActOutput(
          deps,
          directive,
          messages,
          toolCalls,
          "max_total_tool_calls_reached",
        );
      }

      const callSignature = buildCallSignature(call.name, call.input);
      const blockedReason = getBlockedCallReason(call.name, call.input, failedCallSignatures, blockedTools);
      const record = blockedReason
        ? { tool: call.name, input: call.input, output: "", error: blockedReason }
        : await executeSingleTool(deps, call.name, call.input, i + 1);
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
            directive.tools_hint,
            toolSchemas.map((tool) => tool.name),
          ),
        });

        if (blockedReason) {
          const blockedRetryCount = (blockedRetryCounts.get(callSignature) ?? 0) + 1;
          blockedRetryCounts.set(callSignature, blockedRetryCount);
          if (blockedRetryCount >= 2) {
            return await finalizeActOutput(
              deps,
              directive,
              messages,
              toolCalls,
              "repeated_identical_failure",
            );
          }
        }

        if (repeatedCount >= 2) {
          return await finalizeActOutput(
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

  return await finalizeActOutput(
    deps,
    directive,
    messages,
    toolCalls,
    toolCalls.length > 0 ? "max_act_turns_reached" : "no_valid_tool_calls",
  );
}

async function finalizeActOutput(
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

  return buildFallbackActSummary(toolCalls, stoppedEarlyReason);
}

async function executeSingleTool(
  deps: ExecutorDeps,
  toolName: string,
  input: unknown,
  stepId: number,
): Promise<ActToolCallRecord> {
  if (!deps.toolExecutor) {
    return { tool: toolName, input, output: "", error: `No tool executor available` };
  }

  const validation = deps.toolExecutor.validate(toolName, input);
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
  });
  if (!result.ok) {
    return { tool: toolName, input, output: result.output ?? "", error: result.error ?? "Tool execution failed", meta: result.meta };
  }

  return { tool: toolName, input, output: result.output ?? "", meta: result.meta };
}

// --- Phase 2: Verify ---

async function verify(
  deps: ExecutorDeps,
  actOut: ActOutput,
  successCriteria: string,
  pad: string,
  runPath: string,
): Promise<VerifyOutput> {
  const gateResult = checkVerificationGates(actOut, successCriteria);
  if (gateResult && !gateResult.passed) {
    return gateResult;
  }

  const stepResult = gateResult ?? await verifyStepWithLlm(deps, actOut, successCriteria);
  if (!stepResult.passed) {
    return stepResult;
  }

  const mergedFacts = buildStepNewFacts(actOut.toolCalls, stepResult.newFacts);
  const taskResult = await verifyTaskProgress(deps, actOut.finalText.slice(0, 500), mergedFacts);

  return {
    ...stepResult,
    taskStatusAfter: taskResult.taskStatusAfter,
    taskReason: taskResult.taskReason,
    taskEvidence: taskResult.taskEvidence,
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
  const preferredTools = directive.tools_hint.length > 0
    ? directive.tools_hint.join(", ")
    : "none";
  const availableTools = availableToolNames.length > 0
    ? availableToolNames.join(", ")
    : "none";

  return `Execute this step:
Intent: ${directive.intent}
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

Step intent: ${directive.intent}
Success criteria: ${directive.success_criteria}
Tool results:
${toolFacts}`;
}

function buildFallbackActSummary(
  toolCalls: ActToolCallRecord[],
  stoppedEarlyReason: NonNullable<ActOutput["stoppedEarlyReason"]>,
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

  const base = `Step stopped due to ${stoppedEarlyReason} after ${toolCalls.length} tool call(s) (${successfulCalls.length} succeeded, ${failedCalls.length} failed).`;
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
): Promise<VerifyOutput> {
  const actSummary = JSON.stringify({
    toolCalls: actOut.toolCalls.map((call) => ({
      tool: call.tool,
      input: summarizeForPrompt(call.input),
      output: summarizeForPrompt(call.output),
      error: call.error ?? "",
    })),
    finalText: actOut.finalText.slice(0, 500),
  });

  const prompt = `Verify whether this step succeeded.

Action output: ${actSummary}
Success criteria: ${successCriteria}

Respond with JSON:
{ "passed": true|false, "evidence": "...", "newFacts": ["..."], "artifacts": ["..."] }`;

  const turn = await deps.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  const text = turn.type === "assistant" ? turn.content : "";
  try {
    const parsed = parseJSON<Record<string, unknown>>(text);
    return {
      passed: parsed["passed"] === true,
      method: "llm",
      evidence: String(parsed["evidence"] ?? ""),
      newFacts: Array.isArray(parsed["newFacts"]) ? (parsed["newFacts"] as unknown[]).map(String) : [],
      artifacts: Array.isArray(parsed["artifacts"]) ? (parsed["artifacts"] as unknown[]).map(String) : [],
    };
  } catch {
    return { passed: false, method: "llm", evidence: `Failed to parse verify response: ${text}`, newFacts: [], artifacts: [] };
  }
}

async function verifyTaskProgress(
  deps: ExecutorDeps,
  latestSuccessfulStepSummary: string,
  latestStepNewFacts: string[],
): Promise<Pick<VerifyOutput, "taskStatusAfter" | "taskReason" | "taskEvidence">> {
  const effectiveSummary = latestSuccessfulStepSummary.trim().length > 0
    ? latestSuccessfulStepSummary
    : deps.taskContext.latestSuccessfulStepSummary;
  const effectiveFacts = latestStepNewFacts.length > 0
    ? latestStepNewFacts
    : deps.taskContext.latestStepNewFacts;
  const recentDigests = deps.taskContext.recentStepDigests.length > 0
    ? deps.taskContext.recentStepDigests.map((digest) => `- ${digest}`).join("\n")
    : "- none";
  const latestFacts = effectiveFacts.length > 0
    ? effectiveFacts.map((fact) => `- ${fact}`).join("\n")
    : "- none";

  const inputBlock = deps.taskContext.inputKind === "system_event" && deps.taskContext.systemEvent
    ? [
      "Assess overall task progress after the latest successful step.",
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
    : `Assess overall task progress after the latest successful step.

User message: ${deps.taskContext.userMessage}`;

  const prompt = `${inputBlock}
Goal contract:
- objective: ${deps.taskContext.goal.objective || "(none)"}
- done_when: ${formatPromptList(deps.taskContext.goal.done_when)}
- required_evidence: ${formatPromptList(deps.taskContext.goal.required_evidence)}
- ask_user_when: ${formatPromptList(deps.taskContext.goal.ask_user_when)}
- stop_when_no_progress: ${formatPromptList(deps.taskContext.goal.stop_when_no_progress)}
Current taskStatus: ${deps.taskContext.taskStatus}
Current approach: ${deps.taskContext.approach || "(none)"}
Latest successful step summary: ${effectiveSummary || "(none)"}
Latest step newFacts:
${latestFacts}
Recent step digests:
${recentDigests}

Decide the task status using only these values.
- "done" means the goal is satisfied and the user can be answered now.
- "likely_done" means the task is almost complete and the controller should prefer responding.
- "not_done" means more action is clearly needed.
- "blocked" means the task cannot proceed usefully.
- "needs_user_input" means the user must answer before continuing.

Respond with JSON:
{ "taskStatusAfter": "not_done" | "likely_done" | "done" | "blocked" | "needs_user_input", "taskReason": "...", "taskEvidence": ["..."] }`;

  const turn = await deps.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  const text = turn.type === "assistant" ? turn.content : "";
  try {
    const parsed = parseJSON<Record<string, unknown>>(text);
    return {
      taskStatusAfter: normalizeTaskStatus(parsed["taskStatusAfter"]),
      taskReason: String(parsed["taskReason"] ?? ""),
      taskEvidence: Array.isArray(parsed["taskEvidence"])
        ? (parsed["taskEvidence"] as unknown[]).map(String)
        : [],
    };
  } catch {
    return {
      taskStatusAfter: deps.taskContext.taskStatus,
      taskReason: `Failed to parse task verification response: ${text}`,
      taskEvidence: [],
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

function buildStepNewFacts(toolCalls: ActToolCallRecord[], verifyFacts: string[]): string[] {
  const combined: string[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;
    if (call.error) {
      combined.push(`tool_error:${call.tool}#${i + 1}: ${call.error}`);
    } else {
      combined.push(`tool_output:${call.tool}#${i + 1}: ${call.output}`);
    }
  }

  for (const fact of verifyFacts) {
    combined.push(fact);
  }

  return [...new Set(combined)];
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
