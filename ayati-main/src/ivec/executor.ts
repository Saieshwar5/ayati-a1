import type { LlmMessage, LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type {
  ExecutorDeps,
  StepDirective,
  StepSummary,
  FailedApproach,
  ActOutput,
  ActToolCallRecord,
  VerifyOutput,
} from "./types.js";
import { writeJSON } from "./state-persistence.js";
import { checkVerificationGates } from "./verification-gates.js";
import { formatToolResult, formatValidationError } from "./tool-helpers.js";

export async function executeStep(
  deps: ExecutorDeps,
  directive: StepDirective,
  facts: string[],
  stepNumber: number,
  runPath: string,
): Promise<StepSummary> {
  const pad = String(stepNumber).padStart(3, "0");

  const actOut = await act(deps, directive);
  const actFile = `steps/${pad}-act.json`;
  const verifyFile = `steps/${pad}-verify.json`;
  writeJSON(runPath, actFile, actOut);

  const verifyOut = await verify(deps, actOut, directive.success_criteria, pad, runPath);
  writeJSON(runPath, verifyFile, verifyOut);

  const classification = verifyOut.passed
    ? { failureType: undefined, blockedTargets: undefined }
    : classifyFailure(actOut.toolCalls, verifyOut.evidence);
  const toolSuccessCount = actOut.toolCalls.filter((call) => !call.error).length;
  const toolFailureCount = actOut.toolCalls.length - toolSuccessCount;

  return {
    step: stepNumber,
    intent: directive.intent,
    outcome: verifyOut.passed ? "success" : "failed",
    evidence: verifyOut.evidence,
    summary: actOut.finalText.slice(0, 500),
    newFacts: verifyOut.newFacts,
    artifacts: verifyOut.artifacts,
    toolSuccessCount,
    toolFailureCount,
    stoppedEarlyReason: actOut.stoppedEarlyReason,
    actFile,
    verifyFile,
    failureType: classification.failureType,
    blockedTargets: classification.blockedTargets,
  };
}

// --- Phase 1: Act ---

async function act(
  deps: ExecutorDeps,
  directive: StepDirective,
): Promise<ActOutput> {
  const toolSchemas = buildToolSchemas(deps, directive.tools_hint);
  const allowedToolNames = new Set(toolSchemas.map((schema) => schema.name));
  const toolCalls: ActToolCallRecord[] = [];
  const repeatedFailureCounts = new Map<string, number>();
  const maxCallsPerTurn = directive.execution_mode === "independent" ? 2 : 1;
  const maxTotalCalls = Math.max(1, deps.config.maxTotalToolCallsPerStep);
  let executedCalls = 0;

  const prompt = `Execute this step:
Intent: ${directive.intent}
Context: ${directive.context}

Use the available tools to accomplish this. When done, respond with a text summary.`;

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

    const orderedCalls = prioritizeCallsByHint(turn.calls, directive.tools_hint)
      .filter((call) => allowedToolNames.has(call.name))
      .slice(0, maxCallsPerTurn);

    if (orderedCalls.length === 0) {
      return {
        toolCalls,
        finalText: "",
        stoppedEarlyReason: "no_valid_tool_calls",
      };
    }

    for (const call of orderedCalls) {
      if (executedCalls >= maxTotalCalls) {
        return {
          toolCalls,
          finalText: "",
          stoppedEarlyReason: "max_total_tool_calls_reached",
        };
      }

      const record = await executeSingleTool(deps, call.name, call.input, i + 1);
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
        if (repeatedCount >= 2) {
          return {
            toolCalls,
            finalText: "",
            stoppedEarlyReason: "repeated_identical_failure",
          };
        }
      }
    }
  }

  return {
    toolCalls,
    finalText: "",
    stoppedEarlyReason: toolCalls.length > 0 ? "max_act_turns_reached" : "no_valid_tool_calls",
  };
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
    return { tool: toolName, input, output: result.output ?? "", error: result.error ?? "Tool execution failed" };
  }

  return { tool: toolName, input, output: result.output ?? "" };
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
  if (gateResult) return gateResult;

  // LLM fallback
  const summarizeValue = (value: unknown, maxLen = 220): string => {
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
  };

  const actSummary = JSON.stringify({
    toolCalls: actOut.toolCalls.map((call) => ({
      tool: call.tool,
      input: summarizeValue(call.input),
      output: summarizeValue(call.output),
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

// --- Helpers ---

function buildToolSchemas(deps: ExecutorDeps, toolsHint: string[]): LlmToolSchema[] {
  const allDefs = deps.toolDefinitions.length > 0
    ? deps.toolDefinitions
    : (deps.toolExecutor?.definitions() ?? []);

  const filtered = toolsHint.length > 0
    ? allDefs.filter((d) => toolsHint.includes(d.name))
    : allDefs;

  return filtered.map((d) => ({
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
  let normalizedInput = "";
  try {
    normalizedInput = JSON.stringify(input ?? {});
  } catch {
    normalizedInput = String(input);
  }
  return `${toolName}::${normalizedInput}::${normalizedError}`;
}

function parseJSON<T>(text: string): T {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }
  return JSON.parse(jsonStr) as T;
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
