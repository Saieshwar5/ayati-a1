import type { SessionInputHandle } from "../../memory/types.js";
import type { ToolDefinition, ToolResult } from "../../skills/types.js";
import { isReadOnlyTool } from "../../skills/tool-taxonomy.js";
import {
  isGitContextAllowedDuringPendingRouting,
  isGitContextTurnRoutingToolName,
} from "../../skills/builtins/git-context/tool-policy.js";
import type {
  ActOutput,
  ActToolCallRecord,
  AgentLoopDeps,
  LoopConfig,
  LoopState,
} from "../types.js";
import { deriveExecutionStatus } from "../verification-gates.js";
import type { HarnessContextInput } from "../harness-context.js";
import type { AgentAction, AgentDecision } from "./decision.js";
import type { AgentActionExecutionResult } from "./action-executor.js";
import {
  buildStepSummary,
  type ExecuteActionStepResult,
} from "./step-lifecycle.js";
import {
  readRoutingToolStatus,
  summarizeRoutingAttempts,
  validateRoutingAttemptLimits,
} from "./task-routing-policy.js";

export interface ExecutePendingRoutingActionInput {
  deps: AgentLoopDeps;
  state: LoopState;
  config: LoopConfig;
  selectedTools: ToolDefinition[];
  decision: Extract<AgentDecision, { kind: "act" }>;
  stepNumber: number;
  toolContext: {
    clientId: string;
    runId: string;
    sessionId: string;
    stepNumber: number;
  };
  readOnlySessionAction?: boolean;
  applyToolStateUpdates: (state: LoopState, deps: AgentLoopDeps, calls: ActToolCallRecord[]) => Promise<void>;
}

export type TurnRoutingUpdate =
  | {
      status: "ready";
      sessionId: string;
      taskId: string;
      branch: string;
      mode?: string;
      runId: string;
      harnessContext: HarnessContextInput;
    }
  | {
      status: "ambiguous";
      harnessContext: HarnessContextInput;
    };

export async function executePendingRoutingAction(
  input: ExecutePendingRoutingActionInput,
): Promise<ExecuteActionStepResult> {
  const validationError = validatePendingRoutingAction(input);
  const actOutput = validationError
    ? failedPendingRoutingActOutput(input.decision.action, validationError)
    : await executePendingRoutingCalls(input);
  const verifyOutput = buildPendingRoutingVerifyOutput(actOutput);
  const execution: AgentActionExecutionResult = {
    actOutput,
    verifyOutput,
    nextWorkState: input.state.workState,
  };
  await input.applyToolStateUpdates(input.state, input.deps, execution.actOutput.toolCalls);
  const stepSummary = buildStepSummary({
    stepNumber: input.stepNumber,
    action: input.decision.action,
    execution,
  });
  stepSummary.artifacts = stepSummary.artifacts.filter((artifact) => artifact.trim().length > 0);
  return {
    execution,
    stepSummary,
  };
}

export function recordRoutingAttemptFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string | undefined,
  state: LoopState,
  actOutput: ActOutput,
  options: {
    blocked: boolean;
  },
): void {
  const routingCalls = actOutput.toolCalls.filter((call) => isGitContextTurnRoutingToolName(call.tool));
  if (routingCalls.length === 0 && !options.blocked) {
    return;
  }
  recordFeedback(deps, inputHandle, runId, "guard", "routing_attempt_recorded", {
    blocked: options.blocked,
    calls: routingCalls.map((call) => ({
      tool: call.tool,
      status: call.error ? "failed" : readRoutingToolStatus(call) ?? "completed",
      ...(call.error ? { error: call.error } : {}),
    })),
    routing: summarizeRoutingAttempts(state.routingAttempts),
  });
  if (state.routingAttempts.resolved || state.routingAttempts.successCount > 0) {
    recordFeedback(deps, inputHandle, runId, "guard", "routing_resolved", {
      routing: summarizeRoutingAttempts(state.routingAttempts),
    });
  } else if (state.routingAttempts.failureCount >= state.routingAttempts.maxFailures) {
    recordFeedback(deps, inputHandle, runId, "guard", "routing_retry_limit_reached", {
      routing: summarizeRoutingAttempts(state.routingAttempts),
    });
  }
}

function recordFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string | undefined,
  stage: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  deps.feedbackLedger?.record({
    clientId: deps.clientId,
    sessionId: inputHandle.sessionId,
    seq: inputHandle.seq,
    ...(runId ? { runId } : {}),
    stage,
    event,
    ...(data ? { data } : {}),
  });
}

export function extractTurnRoutingUpdate(calls: ActToolCallRecord[]): TurnRoutingUpdate | null {
  for (const call of [...calls].reverse()) {
    const content = call.result?.structuredContent;
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      continue;
    }
    const record = content as Record<string, unknown>;
    const harnessContext = readHarnessContext(record["harnessContext"]);
    if (!harnessContext) {
      continue;
    }
    if (record["status"] === "ready") {
      const sessionId = readString(record["sessionId"]);
      const taskId = readString(record["taskId"]);
      const branch = readString(record["branch"]);
      const runId = readString(record["runId"]);
      const mode = readString(record["mode"]);
      if (sessionId && taskId && branch && runId) {
        return {
          status: "ready",
          sessionId,
          taskId,
          branch,
          ...(mode ? { mode } : {}),
          runId,
          harnessContext,
        };
      }
    }
    if (record["status"] === "ambiguous") {
      return {
        status: "ambiguous",
        harnessContext,
      };
    }
  }
  return null;
}

function validatePendingRoutingAction(input: ExecutePendingRoutingActionInput): string | undefined {
  const action = input.decision.action;
  if (!input.deps.toolExecutor) {
    return "No tool executor is available for pending-turn routing.";
  }
  if (action.mode === "parallel") {
    return "Pending-turn routing cannot run tools in parallel; use single or sequential mode.";
  }
  if (action.calls.length === 0) {
    return "Pending-turn routing action contains no tool calls.";
  }
  if (action.mode === "single" && action.calls.length !== 1) {
    return `Single pending-turn routing action must contain exactly one tool call, received ${action.calls.length}.`;
  }
  if (action.calls.length > input.config.maxSequentialToolCallsPerStep) {
    return `Pending-turn routing requested ${action.calls.length} calls, above max ${input.config.maxSequentialToolCallsPerStep}.`;
  }
  const routingAttemptBlock = validateRoutingAttemptLimits(input.state, action, Boolean(input.state.runId));
  if (routingAttemptBlock) {
    return routingAttemptBlock.message;
  }
  const selected = new Set(input.selectedTools.map((tool) => tool.name));
  const allowed = new Set(action.allowedTools);
  for (const tool of action.allowedTools) {
    if (!selected.has(tool)) {
      return `Allowed tool '${tool}' was not selected for this decision.`;
    }
    if (input.readOnlySessionAction && !isReadOnlyTool(tool)) {
      return `Allowed tool '${tool}' cannot run in a session read-only action before task promotion.`;
    }
  }
  for (const call of action.calls) {
    if (!selected.has(call.tool)) {
      return `Tool '${call.tool}' was not selected for this decision.`;
    }
    if (!allowed.has(call.tool)) {
      return `Tool '${call.tool}' was not listed in action.allowedTools.`;
    }
    if (input.readOnlySessionAction) {
      if (!isReadOnlyTool(call.tool)) {
        return `Tool '${call.tool}' cannot run in a session read-only action before task promotion.`;
      }
    } else if (!isGitContextAllowedDuringPendingRouting(call.tool)) {
      return [
        `Tool '${call.tool}' cannot run while the current task ownership is unbound or clarifying.`,
        "Inspect task candidates, then call git_context_activate_task or git_context_create_task before execution. Ask the user if task ownership is unclear.",
      ].join(" ");
    }
    const validation = input.deps.toolExecutor.validate(call.tool, call.input, input.toolContext);
    if (!validation.valid) {
      return `Tool input preflight failed for '${call.tool}': ${validation.error}`;
    }
  }
  return undefined;
}

async function executePendingRoutingCalls(input: ExecutePendingRoutingActionInput): Promise<ActOutput> {
  const toolCalls: ActToolCallRecord[] = [];
  const failedCallIds = new Set<string>();
  let stoppedByFailure: string | undefined;
  for (const call of input.decision.action.calls) {
    if (stoppedByFailure) {
      const skipped = pendingRoutingToolCallRecord(call, "", `Skipped because an earlier sequential call failed: ${stoppedByFailure}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }
    if (call.dependsOn.some((dep) => failedCallIds.has(dep))) {
      const skipped = pendingRoutingToolCallRecord(call, "", `Skipped because dependency failed: ${call.dependsOn.join(", ")}`);
      failedCallIds.add(call.id);
      toolCalls.push(skipped);
      continue;
    }
    let result: ToolResult;
    try {
      result = await input.deps.toolExecutor!.execute(call.tool, call.input, input.toolContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedCallIds.add(call.id);
      stoppedByFailure = `${call.tool}: ${message}`;
      toolCalls.push(pendingRoutingToolCallRecord(call, "", message));
      continue;
    }
    const output = result.output ?? "";
    const record = pendingRoutingToolCallRecord(call, output, result.error);
    if (result.meta) {
      record.meta = result.meta;
    }
    if (result.v2) {
      record.result = result.v2;
      record.operationStatus = result.v2.operationStatus;
      record.code = result.v2.code;
      record.artifacts = result.v2.artifacts;
      record.verifiedFacts = result.v2.verification?.facts;
      record.assertionResults = result.v2.verification?.assertions;
    }
    if (record.error) {
      failedCallIds.add(call.id);
      stoppedByFailure = `${call.tool}: ${record.error}`;
    }
    toolCalls.push(record);
  }
  return { toolCalls, finalText: "" };
}

function pendingRoutingToolCallRecord(
  call: AgentAction["calls"][number],
  output: string,
  error?: string,
): ActToolCallRecord {
  return {
    callId: call.id,
    tool: call.tool,
    input: call.input,
    output,
    ...(error ? { error } : {}),
    observation: {
      id: `OBS-${call.id}`,
      step: 0,
      callId: call.id,
      tool: call.tool,
      purpose: call.purpose,
      status: error ? "failed" : "success",
      mode: "summary",
      retention: "next_step",
      content: error ? `${call.tool} failed: ${error}` : output,
      hasMore: false,
    },
  };
}

function failedPendingRoutingActOutput(action: AgentAction, error: string): ActOutput {
  return {
    toolCalls: action.calls.length > 0
      ? action.calls.map((call) => pendingRoutingToolCallRecord(call, "", error))
      : [{
        tool: "pending_turn_routing_guard",
        input: action,
        output: "",
        error,
        observation: {
          id: "OBS-pending_turn_routing_guard",
          step: 0,
          callId: "pending_turn_routing_guard",
          tool: "pending_turn_routing_guard",
          status: "failed",
          mode: "summary",
          retention: "next_step",
          content: error,
          hasMore: false,
        },
      }],
    finalText: "",
    stoppedEarlyReason: "planned_call_failed",
  };
}

function buildPendingRoutingVerifyOutput(actOutput: ActOutput): AgentActionExecutionResult["verifyOutput"] {
  const failed = actOutput.toolCalls.filter((call) => call.error);
  const passed = failed.length === 0 && actOutput.toolCalls.length > 0;
  const evidenceItems = actOutput.toolCalls.map((call) => call.error
    ? `${call.tool}: ${call.error}`
    : `${call.tool}: ${call.result?.message ?? "completed"}`);
  return {
    passed,
    method: "execution_gate",
    executionStatus: deriveExecutionStatus(actOutput),
    validationStatus: passed ? "passed" : "failed",
    summary: passed
      ? "Pending-turn routing tools executed successfully."
      : `Pending-turn routing failed: ${failed.map((call) => `${call.tool}: ${call.error}`).join(" | ")}`,
    evidenceSummary: evidenceItems.join(" "),
    evidenceItems,
    newFacts: [],
    artifacts: [],
    usedRawArtifacts: [],
  };
}

function readHarnessContext(value: unknown): HarnessContextInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as HarnessContextInput;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
