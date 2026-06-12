import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmMessage, LlmResponseFormat, LlmTurnOutput } from "../../core/contracts/llm-protocol.js";
import type { ToolContractAssertion, ToolDefinition } from "../../skills/types.js";
import type { RunMetrics } from "../metrics.js";
import { recordPromptMetric, recordRunMetric } from "../metrics.js";
import type { AgentStateView } from "./state-view.js";

export type AgentDecisionStatus = "completed" | "failed";
export type AgentActionMode = "single" | "sequential" | "parallel" | "autonomous";

export interface AgentToolCallSpec {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  purpose?: string;
}

export interface AgentAction {
  mode: AgentActionMode;
  calls: AgentToolCallSpec[];
  allowedTools: string[];
  maxCalls?: number;
  assertions: ToolContractAssertion[];
}

export type AgentDecision =
  | {
      kind: "reply";
      message: string;
      status: AgentDecisionStatus;
    }
  | {
      kind: "ask_user";
      question: string;
      reason: string;
    }
  | {
      kind: "act";
      action: AgentAction;
    };

interface CallAgentDecisionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  toolDefinitions: ToolDefinition[];
  systemContext?: string;
  metrics?: RunMetrics;
}

export async function callAgentDecision(input: CallAgentDecisionInput): Promise<AgentDecision> {
  const promptSections = buildDecisionPromptSections(input.stateView, input.toolDefinitions);
  const prompt = Object.values(promptSections).filter((section) => section.trim().length > 0).join("\n\n");
  const systemContext = buildDecisionSystemContext(input.systemContext);
  const responseFormat = resolveDecisionResponseFormat(input.provider);
  recordPromptMetric(input.metrics, "agent_decision", {
    systemContext,
    ...promptSections,
  });

  let messages: LlmMessage[] = [
    { role: "system", content: systemContext },
    { role: "user", content: prompt },
  ];

  let rawText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const metricStage = attempt === 0 ? "agent_decision" : "agent_decision_repair";
    const startedAt = Date.now();
    let turn: LlmTurnOutput;
    try {
      turn = await input.provider.generateTurn({
        messages,
        ...(responseFormat ? { responseFormat } : {}),
      });
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "success",
      });
    } catch (error) {
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "failed",
      });
      throw error;
    }

    rawText = turn.type === "assistant"
      ? turn.content
      : JSON.stringify({
          kind: "reply",
          status: "failed",
          message: "The decision model returned tool calls instead of a decision JSON object.",
        });

    try {
      return parseAgentDecision(rawText);
    } catch (error) {
      if (attempt > 0) {
        throw error;
      }
      messages = [
        ...messages,
        { role: "assistant", content: rawText },
        {
          role: "user",
          content: "Repair the previous response. Return one valid JSON object only, using exactly one of the documented agent decision shapes.",
        },
      ];
    }
  }

  return parseAgentDecision(rawText);
}

export function parseAgentDecision(text: string): AgentDecision {
  const parsed = unwrapDecisionEnvelope(extractJsonObject(text));
  const kind = parsed["kind"];

  if (kind === "reply") {
    return {
      kind: "reply",
      message: String(parsed["message"] ?? parsed["summary"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
    };
  }

  if (kind === "ask_user") {
    return {
      kind: "ask_user",
      question: String(parsed["question"] ?? ""),
      reason: String(parsed["reason"] ?? ""),
    };
  }

  if (kind === "act") {
    return {
      kind: "act",
      action: normalizeAgentAction(parsed["action"]),
    };
  }

  if (isPlainObject(parsed["action"])) {
    return {
      kind: "act",
      action: normalizeAgentAction(parsed["action"]),
    };
  }

  throw new SyntaxError(`Unsupported agent decision kind: ${String(kind)}`);
}

function buildDecisionSystemContext(systemContext: string | undefined): string {
  const base = `You are the decision component of an AI agent harness.
Choose the next agent decision only. Do not execute tools yourself.
Prefer deterministic actions with concrete tool inputs.
Use the structured context pack in the state view for runtime memory, recentActivity, and recent system events.
Return compact JSON only.`;
  const trimmed = systemContext?.trim();
  if (!trimmed) {
    return base;
  }
  const compact = trimmed.length > 6_000
    ? `${trimmed.slice(0, 6_000).trimEnd()}\n[system context truncated for decision budget]`
    : trimmed;
  return `${base}\n\nSystem context:\n${compact}`;
}

function buildDecisionPromptSections(
  stateView: AgentStateView,
  toolDefinitions: ToolDefinition[],
): Record<string, string> {
  return {
    state: `State view:\n${JSON.stringify(stateView, null, 2)}`,
    tools: `Selected tools:\n${formatSelectedTools(toolDefinitions)}`,
    instructions: `Decision rules:
- Pick exactly one decision: reply, ask_user, or act.
- Treat State view.context as the bounded runtime context pack for this decision.
- Use context.recentActivity as the latest session activity. It contains the last user/assistant exchanges, not raw unlimited history.
- Use context.recentSystemActivity separately from user conversation turns.
- Use reply only when no tool action is needed or the task has failed/finished.
- Use ask_user only when a missing decision prevents safe progress.
- Use act for tool work.
- For deterministic tool tasks, use concrete single/sequential/parallel actions.
- Use autonomous only when exact tool inputs cannot be known yet.
- Keep actions to one phase.
- Use only tools listed in Selected tools.
- Include assertions only for extra checks not already covered by tool contracts.

Response JSON shapes:
{ "kind": "reply", "status": "completed" | "failed", "message": "..." }
{ "kind": "ask_user", "question": "...", "reason": "..." }
{ "kind": "act", "action": { "mode": "single" | "sequential" | "parallel" | "autonomous", "calls": [{ "id": "call_1", "tool": "write_files", "input": {}, "dependsOn": [], "purpose": "..." }], "allowedTools": ["write_files"], "maxCalls": 1, "assertions": [] } }`,
  };
}

function formatSelectedTools(toolDefinitions: ToolDefinition[]): string {
  if (toolDefinitions.length === 0) {
    return "(none)";
  }

  return toolDefinitions.map((tool) => {
    const parts = [
      `- ${tool.name}: ${tool.description}`,
      tool.annotations ? `  annotations=${JSON.stringify(tool.annotations)}` : "",
      tool.inputSchema ? `  inputSchema=${JSON.stringify(tool.inputSchema)}` : "",
      tool.outputSchema ? `  outputSchema=${JSON.stringify(tool.outputSchema)}` : "",
      tool.selectionHints ? `  hints=${JSON.stringify(tool.selectionHints)}` : "",
    ].filter((part) => part.length > 0);
    return parts.join("\n");
  }).join("\n");
}

function resolveDecisionResponseFormat(provider: LlmProvider): LlmResponseFormat | undefined {
  if (provider.capabilities.structuredOutput?.jsonObject) {
    return { type: "json_object" };
  }
  return undefined;
}

function normalizeAgentAction(value: unknown): AgentAction {
  const record = isPlainObject(value) ? value : {};
  const mode = normalizeActionMode(record["mode"]);
  const calls = Array.isArray(record["calls"])
    ? record["calls"].map(normalizeToolCallSpec).filter((call): call is AgentToolCallSpec => call !== null)
    : [];
  const allowedTools = Array.isArray(record["allowedTools"])
    ? record["allowedTools"].map(String).filter((tool) => tool.trim().length > 0)
    : Array.isArray(record["allowed_tools"])
      ? record["allowed_tools"].map(String).filter((tool) => tool.trim().length > 0)
      : [];
  const maxCalls = normalizePositiveInteger(record["maxCalls"] ?? record["max_calls"]);
  const assertions = Array.isArray(record["assertions"])
    ? record["assertions"].filter(isPlainObject) as ToolContractAssertion[]
    : [];

  return {
    mode,
    calls,
    allowedTools,
    ...(maxCalls ? { maxCalls } : {}),
    assertions,
  };
}

function normalizeActionMode(value: unknown): AgentActionMode {
  return value === "single" || value === "sequential" || value === "parallel" || value === "autonomous"
    ? value
    : "single";
}

function normalizeToolCallSpec(value: unknown): AgentToolCallSpec | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const tool = String(value["tool"] ?? "").trim();
  if (!tool) {
    return null;
  }
  const rawInput = value["input"];
  const input = isPlainObject(rawInput) ? { ...rawInput } : {};
  const rawDependsOn = value["dependsOn"] ?? value["depends_on"];
  return {
    id: String(value["id"] ?? tool).trim() || tool,
    tool,
    input,
    dependsOn: Array.isArray(rawDependsOn)
      ? rawDependsOn.map(String).filter((dep) => dep.trim().length > 0)
      : [],
    purpose: typeof value["purpose"] === "string" ? value["purpose"] : undefined,
  };
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = unwrapJsonFence(text.trim());
  const direct = parseJsonRecord(trimmed);
  if (direct) {
    return direct;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    throw new SyntaxError(`Expected JSON object but received: ${text.slice(0, 120)}`);
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (!char) continue;

    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, index + 1);
        const parsed = parseJsonRecord(candidate);
        if (parsed) {
          return parsed;
        }
      }
    }
  }

  throw new SyntaxError(`Expected JSON object but received: ${text.slice(0, 120)}`);
}

function unwrapJsonFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return text;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unwrapDecisionEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  if (typeof record["kind"] === "string" && isPlainObject(record["payload"])) {
    return { kind: record["kind"], ...record["payload"] };
  }
  return record;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
