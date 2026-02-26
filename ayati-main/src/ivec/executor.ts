import type { LlmMessage, LlmToolSchema } from "../core/contracts/llm-protocol.js";
import type {
  ExecutorDeps,
  StepDirective,
  StepSummary,
  ReasonOutput,
  ActOutput,
  ActToolCallRecord,
  VerifyOutput,
} from "./types.js";
import { writeJSON } from "./state-persistence.js";
import { checkVerificationGates } from "./verification-gates.js";
import { formatToolResult, formatValidationError } from "./tool-helpers.js";
import { buildToolCatalog } from "./tool-catalog.js";

export async function executeStep(
  deps: ExecutorDeps,
  directive: StepDirective,
  facts: string[],
  stepNumber: number,
  runPath: string,
): Promise<StepSummary> {
  const pad = String(stepNumber).padStart(3, "0");

  const reasonOut = await reason(deps, directive, facts);
  writeJSON(runPath, `steps/${pad}-reason.json`, reasonOut);

  const actOut = await act(deps, directive, reasonOut);
  writeJSON(runPath, `steps/${pad}-act.json`, actOut);

  const verifyOut = await verify(deps, actOut, directive.success_criteria, pad, runPath);
  writeJSON(runPath, `steps/${pad}-verify.json`, verifyOut);

  return {
    step: stepNumber,
    intent: directive.intent,
    outcome: verifyOut.passed ? "success" : "failed",
    evidence: verifyOut.evidence,
    summary: actOut.finalText.slice(0, 500),
    newFacts: verifyOut.newFacts,
    artifacts: verifyOut.artifacts,
  };
}

// --- Phase 1: Reason ---

async function reason(
  deps: ExecutorDeps,
  directive: StepDirective,
  facts: string[],
): Promise<ReasonOutput> {
  const factsBlock = facts.length > 0
    ? `Known facts:\n${facts.map((f) => `- ${f}`).join("\n")}`
    : "No facts established yet.";

  const toolCatalog = buildToolCatalog(deps.toolDefinitions);

  const hintedTools = directive.tools_hint.length > 0
    ? `\nSuggested tools for this step: ${directive.tools_hint.join(", ")}`
    : "";

  const prompt = `You are planning how to execute a single step.

Intent: ${directive.intent}
Type: ${directive.type}

${factsBlock}

${toolCatalog}${hintedTools}

Think about the best approach, considering which tools to use and how. Respond with JSON:
{ "thinking": "...", "approach": "...", "potential_issues": ["..."] }`;

  const turn = await deps.provider.generateTurn({
    messages: [{ role: "user", content: prompt }],
  });

  const text = turn.type === "assistant" ? turn.content : "";
  try {
    return parseJSON<ReasonOutput>(text);
  } catch {
    return { thinking: text, approach: directive.intent, potential_issues: [] };
  }
}

// --- Phase 2: Act ---

async function act(
  deps: ExecutorDeps,
  directive: StepDirective,
  reasonOut: ReasonOutput,
): Promise<ActOutput> {
  const toolSchemas = buildToolSchemas(deps, directive.tools_hint);
  const toolCalls: ActToolCallRecord[] = [];

  const prompt = `Execute this step:
Intent: ${directive.intent}
Approach: ${reasonOut.approach}

Use the available tools to accomplish this. When done, respond with a text summary.`;

  const messages: LlmMessage[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < deps.config.maxToolCallsPerStep; i++) {
    const turn = await deps.provider.generateTurn({
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    });

    if (turn.type === "assistant") {
      return { toolCalls, finalText: turn.content };
    }

    for (const call of turn.calls) {
      const record = await executeSingleTool(deps, call.name, call.input, i + 1);
      toolCalls.push(record);

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
    }
  }

  return { toolCalls, finalText: "" };
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

// --- Phase 3: Verify ---

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
  const actSummary = JSON.stringify({
    toolCalls: actOut.toolCalls.length,
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

function parseJSON<T>(text: string): T {
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }
  return JSON.parse(jsonStr) as T;
}
