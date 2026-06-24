import type { LlmProvider } from "../../core/contracts/provider.js";
import type { LlmMessage, LlmToolCall, LlmToolSchema, LlmTurnOutput } from "../../core/contracts/llm-protocol.js";
import { agentTrace, isAgentTracePromptEnabled, tracePreview } from "../../shared/index.js";
import type { ToolContractAssertion, ToolDefinition } from "../../skills/types.js";
import type { AgentFeedbackLedger } from "../feedback-ledger.js";
import type { RunMetrics } from "../metrics.js";
import { recordPromptMetric, recordProviderUsageMetric, recordRunMetric } from "../metrics.js";
import type { AgentStateView } from "./state-view.js";

export type AgentDecisionStatus = "completed" | "failed";
export type AgentActionMode = "single" | "sequential" | "parallel";

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
  assertions: ToolContractAssertion[];
}

export interface AgentToolLoadRequest {
  query?: string;
  toolNames: string[];
  groups: string[];
}

export type DecisionFailureKind =
  | "invalid_json"
  | "unsupported_decision_kind"
  | "tool_protocol_violation"
  | "tool_input_schema_violation";

export type AgentDecision =
  | {
      kind: "reply";
      message: string;
      status: AgentDecisionStatus;
      workingNotes?: string[];
    }
  | {
      kind: "ask_user";
      question: string;
      reason: string;
      workingNotes?: string[];
    }
  | {
      kind: "act";
      action: AgentAction;
      workingNotes?: string[];
    }
  | {
      kind: "load_tools";
      request: AgentToolLoadRequest;
      workingNotes?: string[];
    };

interface CallAgentDecisionInput {
  provider: LlmProvider;
  stateView: AgentStateView;
  toolDefinitions: ToolDefinition[];
  toolRoutingSummary?: string;
  systemContext?: string;
  metrics?: RunMetrics;
  feedbackLedger?: AgentFeedbackLedger;
  feedbackContext?: AgentDecisionFeedbackContext;
}

interface ToolProtocolViolation {
  kind: Extract<DecisionFailureKind, "tool_protocol_violation">;
  reason: string;
  invalidTools: string[];
  selectedTools: string[];
  loadToolsUsedAsAction: boolean;
}

interface AgentDecisionFeedbackContext {
  clientId: string;
  sessionId: string;
  seq: number;
  runId?: string;
}

const MAX_DECISION_ATTEMPTS = 3;
const TOOL_PROTOCOL_FAILURE_REPLY = "I could not form a valid tool decision for this request.";

export async function callAgentDecision(input: CallAgentDecisionInput): Promise<AgentDecision> {
  const promptSections = buildDecisionPromptSections(input.stateView, input.toolDefinitions, input.toolRoutingSummary);
  const prompt = Object.values(promptSections).filter((section) => section.trim().length > 0).join("\n\n");
  const systemSections = buildDecisionSystemSections(input.systemContext);
  const systemContext = Object.values(systemSections).filter((section) => section.trim().length > 0).join("\n\n");
  recordPromptMetric(input.metrics, "agent_decision", {
    "system.stableDecisionRules": systemSections.stableDecisionRules,
    "system.runtimeContext": systemSections.runtimeContext,
    ...promptSections,
  }, {
    stateBreakdown: buildStateViewPromptBreakdown(input.stateView),
  });

  let messages: LlmMessage[] = [
    { role: "system", content: systemContext },
    { role: "user", content: prompt },
  ];

  let rawText = "";
  for (let attempt = 0; attempt < MAX_DECISION_ATTEMPTS; attempt++) {
    const metricStage = attempt === 0 ? "agent_decision" : "agent_decision_repair";
    const startedAt = Date.now();
    let turn: LlmTurnOutput;
    traceDecisionProviderRequest(input.provider, messages, attempt);
    try {
      if (!input.provider.capabilities.nativeToolCalling) {
        throw new Error(`Provider ${input.provider.name} does not support native decision tools.`);
      }
      const decisionTools = buildNativeDecisionTools(input.toolDefinitions);
      turn = await input.provider.generateTurn({
        messages,
        tools: decisionTools,
        toolChoice: "required",
        parallelToolCalls: false,
      });
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "success",
      });
      recordProviderUsageMetric(input.metrics, metricStage, turn.usage, turn.cost);
    } catch (error) {
      recordRunMetric(input.metrics, metricStage, {
        durationMs: Date.now() - startedAt,
        kind: "llm",
        status: "failed",
      });
      throw error;
    }
    traceDecisionProviderResponse(turn, attempt);

    rawText = turn.type === "assistant"
      ? turn.content
      : serializeNativeDecisionToolCalls(turn.calls);
    agentTrace("agent_decision", `attempt=${attempt + 1} raw_response=${tracePreview(rawText)}`);
    recordDecisionFeedback(input, "raw_response", {
      attempt: attempt + 1,
      turnType: turn.type,
      rawResponse: rawText,
    });

    try {
      const decision = parseAgentDecision(rawText);
      agentTrace("agent_decision", `attempt=${attempt + 1} parsed_decision kind=${decision.kind}`);
      recordDecisionFeedback(input, "parsed", {
        attempt: attempt + 1,
        decision: summarizeDecisionForFeedback(decision),
      });
      const violation = validateToolProtocol(decision, input.toolDefinitions);
      if (!violation) {
        return decision;
      }
      agentTrace(
        "agent_decision",
        `attempt=${attempt + 1} tool_protocol_violation reason=${violation.reason} invalidTools=${violation.invalidTools.join(",") || "(none)"}`,
      );
      recordDecisionFeedback(input, "protocol_violation", {
        attempt: attempt + 1,
        ...violation,
      });
      if (attempt >= MAX_DECISION_ATTEMPTS - 1) {
        agentTrace("agent_decision", `attempt=${attempt + 1} tool_protocol_failed_fallback`);
        recordDecisionFeedback(input, "failed_fallback", {
          attempt: attempt + 1,
          reason: violation.reason,
        });
        return {
          kind: "reply",
          status: "failed",
          message: TOOL_PROTOCOL_FAILURE_REPLY,
        };
      }
      agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=tool_protocol_violation`);
      recordDecisionFeedback(input, "repair_requested", {
        attempt: attempt + 1,
        reason: "tool_protocol_violation",
        violation,
      });
      messages = buildRepairMessages(messages, rawText, buildToolProtocolRepairPrompt(violation));
      continue;
    } catch (error) {
      agentTrace(
        "agent_decision",
        `attempt=${attempt + 1} parse_failed error=${error instanceof Error ? error.message : String(error)}`,
      );
      recordDecisionFeedback(input, "parse_failed", {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt >= 1) {
        throw error;
      }
      agentTrace("agent_decision", `attempt=${attempt + 1} repair_request reason=parse_failed`);
      recordDecisionFeedback(input, "repair_requested", {
        attempt: attempt + 1,
        reason: "parse_failed",
      });
      messages = buildRepairMessages(
        messages,
        rawText,
        "Repair the previous response. Call exactly one native decision tool. Do not answer with text, JSON, or markdown.",
      );
    }
  }

  return parseAgentDecision(rawText);
}

function recordDecisionFeedback(
  input: CallAgentDecisionInput,
  event: string,
  data: Record<string, unknown>,
): void {
  if (!input.feedbackLedger || !input.feedbackContext) {
    return;
  }
  input.feedbackLedger.record({
    ...input.feedbackContext,
    stage: "decision",
    event,
    data,
  });
}

function summarizeDecisionForFeedback(decision: AgentDecision): Record<string, unknown> {
  if (decision.kind === "reply") {
    return {
      kind: decision.kind,
      status: decision.status,
      message: decision.message,
    };
  }
  if (decision.kind === "ask_user") {
    return {
      kind: decision.kind,
      question: decision.question,
      reason: decision.reason,
    };
  }
  if (decision.kind === "load_tools") {
    return {
      kind: decision.kind,
      request: decision.request,
    };
  }
  return {
    kind: decision.kind,
    mode: decision.action.mode,
    calls: decision.action.calls.map((call) => ({
      id: call.id,
      tool: call.tool,
      dependsOn: call.dependsOn,
      purpose: call.purpose,
    })),
    allowedTools: decision.action.allowedTools,
  };
}

function buildRepairMessages(messages: LlmMessage[], rawText: string, prompt: string): LlmMessage[] {
  return [
    ...messages,
    { role: "assistant", content: rawText },
    {
      role: "user",
      content: prompt,
    },
  ];
}

function validateToolProtocol(
  decision: AgentDecision,
  selectedToolDefinitions: ToolDefinition[],
): ToolProtocolViolation | null {
  const selectedTools = selectedToolDefinitions.map((tool) => tool.name);
  if (decision.kind === "load_tools") {
    const hasSelector = Boolean(decision.request.query?.trim())
      || decision.request.toolNames.length > 0
      || decision.request.groups.length > 0;
    if (hasSelector) {
      return null;
    }
    return {
      kind: "tool_protocol_violation",
      reason: "load_tools request must include at least one non-empty selector: groups, toolNames, or query",
      invalidTools: [],
      selectedTools,
      loadToolsUsedAsAction: false,
    };
  }

  if (decision.kind !== "act") {
    return null;
  }

  const selectedToolSet = new Set(selectedTools);
  const invalidCallTools = decision.action.calls
    .map((call) => call.tool)
    .filter((tool) => tool === "load_tools" || !selectedToolSet.has(tool));
  const invalidAllowedTools = decision.action.allowedTools.filter((tool) => tool === "load_tools" || !selectedToolSet.has(tool));
  const invalidTools = uniqueStrings([...invalidCallTools, ...invalidAllowedTools]);
  const loadToolsUsedAsAction = decision.action.calls.some((call) => call.tool === "load_tools");

  if (decision.action.calls.length === 0) {
    return {
      kind: "tool_protocol_violation",
      reason: "act decision contained no tool calls",
      invalidTools,
      selectedTools,
      loadToolsUsedAsAction,
    };
  }

  if (invalidTools.length === 0 && !loadToolsUsedAsAction) {
    return null;
  }

  return {
    kind: "tool_protocol_violation",
    reason: loadToolsUsedAsAction
      ? "load_tools was used as an action tool"
      : "act decision referenced tools not listed in Selected tools",
    invalidTools,
    selectedTools,
    loadToolsUsedAsAction,
  };
}

function buildToolProtocolRepairPrompt(violation: ToolProtocolViolation): string {
  const selected = violation.selectedTools.length > 0 ? violation.selectedTools.join(", ") : "(none)";
  const invalid = violation.invalidTools.length > 0 ? violation.invalidTools.join(", ") : "(none)";
  return [
    "Your previous decision violates the Ayati tool protocol.",
    "",
    `Selected tools: ${selected}`,
    `Invalid tools in action.calls or allowedTools: ${invalid}`,
    violation.loadToolsUsedAsAction
      ? "Also invalid: load_tools was used as an action tool. Use decision_load_tools instead of putting load_tools in action.calls."
      : "",
    "",
    "Call exactly one native decision tool:",
    "- reply only for terminal outcomes: pure conversation, completed work, failed task, or impossible task.",
    "- ask_user only for hard blockers that prevent safe progress and have no reasonable default.",
    "- decision_load_tools when the next useful action needs tools that are not selected yet.",
    "- act only when every action.calls[].tool is listed in Selected tools.",
    "",
    "Do not call unselected tools. Do not put load_tools inside action.calls. Do not reply to promise future tool work.",
  ].filter((line) => line.length > 0).join("\n");
}

function traceDecisionProviderRequest(
  provider: LlmProvider,
  messages: LlmMessage[],
  attempt: number,
): void {
  agentTrace(
    "agent_decision",
    `attempt=${attempt + 1} provider_request provider=${provider.name} version=${provider.version} nativeDecisionTools=required messages=${messages.length}`,
  );
  if (isAgentTracePromptEnabled()) {
    agentTrace("agent_decision", `attempt=${attempt + 1} prompt=${tracePreview(messages)}`);
  }
}

function traceDecisionProviderResponse(turn: LlmTurnOutput, attempt: number): void {
  const usage = turn.usage
    ? ` usage=${turn.usage.provider}:${turn.usage.model} input=${turn.usage.inputTokens} output=${turn.usage.outputTokens} total=${turn.usage.totalTokens}`
    : "";
  agentTrace("agent_decision", `attempt=${attempt + 1} provider_response type=${turn.type}${usage}`);
}

export function parseAgentDecision(text: string): AgentDecision {
  const parsed = extractJsonObject(text);
  const kind = parsed["kind"];

  if (kind === "reply") {
    return {
      kind: "reply",
      message: String(parsed["message"] ?? ""),
      status: parsed["status"] === "failed" ? "failed" : "completed",
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "ask_user") {
    return {
      kind: "ask_user",
      question: String(parsed["question"] ?? ""),
      reason: String(parsed["reason"] ?? ""),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "act") {
    return {
      kind: "act",
      action: normalizeAgentAction(parsed["action"]),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  if (kind === "load_tools") {
    return {
      kind: "load_tools",
      request: normalizeToolLoadRequest(parsed["request"] ?? parsed),
      workingNotes: normalizeWorkingNotes(parsed["workingNotes"]),
    };
  }

  throw new SyntaxError(`Unsupported agent decision kind: ${String(kind)}`);
}

const STABLE_DECISION_SYSTEM_CONTEXT = `You are the decision component of an AI agent harness.
Choose the next agent decision only. Do not execute tools yourself.
Prefer deterministic actions with concrete tool inputs.
Use the structured context pack and optional work state in the state view.
Call exactly one native decision tool. Do not answer directly with prose, markdown, or JSON text.

Decision rules:
- Call exactly one native decision tool: decision_reply, decision_ask_user, decision_load_tools, or decision_act.
- Treat State view.context as the bounded context pack for this decision.
- Use context.timeline as chronological conversation context. The item with current=true is the current input.
- Use the immediately preceding assistant item in context.timeline to interpret short replies like yes, no, do it, go ahead, continue, or stop.
- Use context.continuity.current as compact durable task state when present.
- Use context.sessionWork only as compact same-session work awareness; do not treat it as raw conversation.
- Use context.continuity for durable task/project state, not as a replacement for immediate dialogue context.
- Treat State view.progress as the authoritative current task progress. It may be absent on the first decision.
- Use State view.observations.latest as the latest real tool output cards. If these cards answer the user, reply instead of rerunning equivalent tools.
- Use State view.trace.recentSteps only as compact execution history, not as evidence.
- Use State view.trace.recentFailures to avoid repeating failed paths.
- Do not use workingNotes as factual memory; the harness owns tool-output context.
- Use evidence tools for truncated or chunked evidence before rerunning the original output-producing tool.
- If State view.progress.status is "done", return a reply. Do not call more tools.
- Autonomous execution policy: for actionable user requests, prefer progress over discussion.
- Treat preference gaps as assumptions, not blockers, when reasonable safe defaults exist.
- Treat short confirmations or delegation like "yes", "go ahead", "continue", "do it", "whatever feels right", and "surprise me" as permission to proceed with reasonable defaults.
- Use reply only as a terminal decision: pure conversation, final answer after completed work, failed task, or impossible task.
- Do not use decision_reply to say you will do future work. If work remains, call decision_act or decision_load_tools.
- Final replies must answer the user's request in natural, human-readable language.
- Do not mention internal execution details in final replies: tool calls, deterministic verification, evidence contracts, assertions, reducers, work state, or harness steps.
- Use user-visible results from observations and trace summaries, such as created paths, changed files, command results, document findings, or next steps.
- Use ask_user only for hard blockers: missing target with no safe default, destructive or irreversible action, credentials or approval required, external cost/account action, or true ambiguity where the wrong choice would likely waste substantial work.
- Do not ask_user for style, wording, organization, or preference choices when reasonable defaults can satisfy the request.
- Use decision_act for tool work.
- Use decision_load_tools when the visible selected tools are not enough for the next action. Do not tell the user tools are missing.
- decision_load_tools must include a non-empty selector: exact toolNames when known, groups when a group fits, or query when uncertain.
- Tool protocol has two separate phases: decision_load_tools only changes the visible tool set for a later decision; decision_act executes selected tools.
- decision_load_tools is a meta decision tool, not an executable tool. Never put "load_tools" inside action.calls.
- If Selected tools is "(none)", decision_act is invalid. Call decision_reply, decision_ask_user, or decision_load_tools.
- action.calls may contain only tool names listed under Selected tools.
- action.allowedTools may contain only tool names listed under Selected tools.
- For deterministic tool tasks, use concrete single/sequential/parallel actions.
- Use single for exactly one tool call.
- Use sequential for dependent tool calls, up to 4 calls. If a later call depends on an earlier result or path, use sequential.
- Use parallel only for independent tool calls, up to 3 calls. Do not use parallel for dependent filesystem writes.
- Parallel is deny-by-default. Use it only for clearly read-only, retry-safe, non-long-running tools such as calculator, evidence reads, and read-only filesystem inspection.
- Do not use parallel for shell, python, UI/workspace, memory mutation, pulse, database mutation, skill activation, or any file write/create/edit/move/delete task.
- Keep actions to one phase.
- Use only tools listed in Selected tools.
- Prefer write_files for generated websites, apps, and multi-file file creation.
- Hidden tools are loaded by decision_load_tools, not by calling skill_search or skill_activate.
- Do not include assertions. Tool-owned contracts provide deterministic verification.

Decision tool shapes:
- decision_reply({ "status": "completed" | "failed", "message": "..." })
- decision_ask_user({ "question": "...", "reason": "..." })
- decision_load_tools({ "query": "...", "toolNames": ["read_file"], "groups": ["workflow:code_edit"] })
- decision_act({ "mode": "single" | "sequential" | "parallel", "calls": [{ "id": "call_1", "tool": "write_files", "input": {}, "dependsOn": [], "purpose": "..." }], "allowedTools": ["write_files"] })

Tool protocol examples:
- Bad when shell is not selected: decision_act with action.calls using "shell" or "load_tools".
- Good instead: decision_load_tools({ "groups": ["skill:shell"] }).
- Good after shell appears in Selected tools: decision_act with one selected "shell" call.`;

function buildDecisionSystemSections(systemContext: string | undefined): Record<string, string> {
  const trimmed = systemContext?.trim();
  if (!trimmed) {
    return {
      stableDecisionRules: STABLE_DECISION_SYSTEM_CONTEXT,
      runtimeContext: "",
    };
  }
  const compact = trimmed.length > 6_000
    ? `${trimmed.slice(0, 6_000).trimEnd()}\n[system context truncated for decision budget]`
    : trimmed;
  return {
    stableDecisionRules: STABLE_DECISION_SYSTEM_CONTEXT,
    runtimeContext: `System context:\n${compact}`,
  };
}

function buildDecisionPromptSections(
  stateView: AgentStateView,
  toolDefinitions: ToolDefinition[],
  toolRoutingSummary: string | undefined,
): Record<string, string> {
  return {
    "user.tools": `Selected tools:\n${formatSelectedTools(toolDefinitions)}`,
    "user.toolRouting": toolRoutingSummary?.trim()
      ? `Tool loading map (request these with decision_load_tools, not action.calls):\n${toolRoutingSummary.trim()}`
      : "",
    "user.state": `State view:\n${JSON.stringify(stateView, null, 2)}`,
  };
}

function buildStateViewPromptBreakdown(stateView: AgentStateView): Record<string, string | undefined> {
  return {
    "state.context": stringifySection(stateView.context),
    "state.context.timeline": stringifySection(stateView.context.timeline),
    "state.context.continuity": stringifySection(stateView.context.continuity),
    "state.context.sessionWork": stringifySection(stateView.context.sessionWork),
    "state.context.personalMemorySnapshot": stateView.context.personalMemorySnapshot,
    "state.progress": stringifySection(stateView.progress),
    "state.observations": stringifySection(stateView.observations),
    "state.trace": stringifySection(stateView.trace),
    "state.attachments": stringifySection(stateView.attachments),
    "state.systemEvent": stringifySection(stateView.systemEvent),
  };
}

function stringifySection(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
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

function normalizeAgentAction(value: unknown): AgentAction {
  const record = isPlainObject(value) ? value : {};
  const mode = normalizeActionMode(record["mode"]);
  const calls = Array.isArray(record["calls"])
    ? record["calls"].map(normalizeToolCallSpec).filter((call): call is AgentToolCallSpec => call !== null)
    : [];
  const allowedTools = Array.isArray(record["allowedTools"])
    ? record["allowedTools"].map(String).filter((tool) => tool.trim().length > 0)
    : [];
  const assertions: ToolContractAssertion[] = [];

  return {
    mode,
    calls,
    allowedTools,
    assertions,
  };
}

function normalizeToolLoadRequest(value: unknown): AgentToolLoadRequest {
  const record = isPlainObject(value) ? value : {};
  return {
    query: typeof record["query"] === "string" ? record["query"] : undefined,
    toolNames: normalizeStringArray(record["toolNames"]),
    groups: normalizeStringArray(record["groups"]),
  };
}

function normalizeWorkingNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notes = value
    .map((note) => String(note).replace(/\s+/g, " ").trim())
    .filter((note) => note.length > 0)
    .slice(0, 12);
  return notes.length > 0 ? notes : [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter((item) => item.length > 0)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function normalizeActionMode(value: unknown): AgentActionMode {
  return value === "single" || value === "sequential" || value === "parallel"
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
  const rawDependsOn = value["dependsOn"];
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DECISION_TOOL_NAMES = new Set([
  "decision_reply",
  "decision_ask_user",
  "decision_load_tools",
  "decision_act",
]);

function buildNativeDecisionTools(selectedTools: ToolDefinition[]): LlmToolSchema[] {
  return [
    {
      name: "decision_reply",
      description: "Finish this decision with a user-facing reply. Use when no tool loading or tool execution is needed.",
      inputSchema: objectSchema({
        status: {
          type: "string",
          enum: ["completed", "failed"],
        },
        message: {
          type: "string",
          minLength: 1,
        },
        workingNotes: workingNotesSchema(),
      }, ["status", "message"]),
    },
    {
      name: "decision_ask_user",
      description: "Ask the user for required information only when progress is blocked and no safe default exists.",
      inputSchema: objectSchema({
        question: {
          type: "string",
          minLength: 1,
        },
        reason: {
          type: "string",
          minLength: 1,
        },
        workingNotes: workingNotesSchema(),
      }, ["question", "reason"]),
    },
    {
      name: "decision_load_tools",
      description: "Request hidden tools by exact group, exact tool name, or search query when selected tools are insufficient.",
      inputSchema: {
        ...objectSchema({
          query: {
            type: "string",
            minLength: 1,
          },
          toolNames: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
            maxItems: 12,
          },
          groups: {
            type: "array",
            items: {
              type: "string",
              minLength: 1,
            },
            maxItems: 12,
          },
          workingNotes: workingNotesSchema(),
        }, []),
        anyOf: [
          { required: ["query"] },
          { required: ["toolNames"] },
          { required: ["groups"] },
        ],
      },
    },
    {
      name: "decision_act",
      description: "Plan execution using only the selected executable tools listed in the prompt. Ayati validates and executes the plan locally.",
      inputSchema: buildNativeDecisionActSchema(selectedTools),
    },
  ];
}

function buildNativeDecisionActSchema(selectedTools: ToolDefinition[]): Record<string, unknown> {
  const selectedToolNames = selectedTools.map((tool) => tool.name);
  const toolEnum = selectedToolNames.length > 0 ? selectedToolNames : ["__no_selected_tools__"];
  return objectSchema({
    mode: {
      type: "string",
      enum: ["single", "sequential", "parallel"],
    },
    allowedTools: {
      type: "array",
      items: {
        type: "string",
        enum: toolEnum,
      },
      minItems: 1,
      maxItems: 12,
    },
    calls: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: objectSchema({
        id: {
          type: "string",
          minLength: 1,
        },
        tool: {
          type: "string",
          enum: toolEnum,
        },
        input: {
          type: "object",
        },
        purpose: {
          type: "string",
          minLength: 1,
        },
        dependsOn: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 4,
        },
      }, ["id", "tool", "input", "purpose", "dependsOn"]),
    },
    assertions: {
      type: "array",
      items: {
        type: "object",
      },
      maxItems: 8,
    },
    workingNotes: workingNotesSchema(),
  }, ["mode", "allowedTools", "calls"]);
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function workingNotesSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "string",
    },
    maxItems: 5,
  };
}

function serializeNativeDecisionToolCalls(calls: LlmToolCall[]): string {
  if (calls.length !== 1) {
    return `native_decision_error: expected exactly one decision tool call, received ${calls.length}.`;
  }

  const call = calls[0]!;
  if (!DECISION_TOOL_NAMES.has(call.name)) {
    return `native_decision_error: unknown decision tool '${call.name}'. Executable tools must be requested through decision_act.`;
  }

  const input = isPlainObject(call.input) ? call.input : {};
  return JSON.stringify(nativeDecisionToolCallToPayload(call.name, input));
}

function nativeDecisionToolCallToPayload(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case "decision_reply":
      return {
        kind: "reply",
        status: input["status"],
        message: input["message"],
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case "decision_ask_user":
      return {
        kind: "ask_user",
        question: input["question"],
        reason: input["reason"],
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case "decision_load_tools":
      return {
        kind: "load_tools",
        request: {
          ...(input["query"] ? { query: input["query"] } : {}),
          ...(input["toolNames"] ? { toolNames: input["toolNames"] } : {}),
          ...(input["groups"] ? { groups: input["groups"] } : {}),
        },
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    case "decision_act":
      return {
        kind: "act",
        action: {
          mode: input["mode"],
          allowedTools: input["allowedTools"],
          calls: input["calls"],
          assertions: input["assertions"] ?? [],
        },
        ...(input["workingNotes"] ? { workingNotes: input["workingNotes"] } : {}),
      };
    default:
      return {
        kind: "reply",
        status: "failed",
        message: `Unknown native decision tool: ${toolName}`,
      };
  }
}
