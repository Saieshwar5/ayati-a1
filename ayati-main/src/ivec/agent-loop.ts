import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
  LlmTurnInput,
} from "../core/contracts/llm-protocol.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolResult } from "../skills/types.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { ContextRecallService } from "./context-recall-service.js";
import type {
  AgentLoopConfig,
  AgentLoopResult,
  AgentStepInput,
  RunState,
  ScratchpadEntry,
} from "./agent-loop-types.js";
import { DEFAULT_LOOP_CONFIG } from "./agent-loop-types.js";
import {
  AGENT_STEP_TOOL_NAME,
  AGENT_STEP_TOOL_SCHEMA,
  parseAgentStep,
  buildScratchpadBlock,
} from "./agent-step-tool.js";
import {
  CONTEXT_RECALL_TOOL_NAME,
  formatToolResult,
  toToolSchemas,
} from "./tool-helpers.js";
import {
  estimateTextTokens,
  estimateTurnInputTokens,
} from "../prompt/token-estimator.js";
import { devLog, devError } from "../shared/index.js";

export class AgentLoop {
  private readonly provider: LlmProvider;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly contextRecallService: ContextRecallService;
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly config: AgentLoopConfig;

  constructor(
    provider: LlmProvider,
    toolExecutor: ToolExecutor | undefined,
    sessionMemory: SessionMemory,
    contextRecallService: ContextRecallService,
    onReply?: (clientId: string, data: unknown) => void,
    config?: Partial<AgentLoopConfig>,
  ) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
    this.sessionMemory = sessionMemory;
    this.contextRecallService = contextRecallService;
    this.onReply = onReply;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
  }

  async run(
    clientId: string,
    userContent: string,
    systemContext: string,
    dynamicSystemTokens: number,
    runHandle: MemoryRunHandle,
    staticSystemTokens: number,
    resolveModelName: (providerName: string) => string,
  ): Promise<AgentLoopResult> {
    const realTools = toToolSchemas(this.toolExecutor);
    const allTools: LlmToolSchema[] = [AGENT_STEP_TOOL_SCHEMA, ...realTools];

    const state: RunState = {
      step: 0,
      scratchpad: [],
      approachesTried: new Set(),
      toolCallsMade: 0,
      consecutiveNonActSteps: 0,
    };

    const messages: LlmMessage[] = [];
    if (systemContext.trim().length > 0) {
      messages.push({ role: "system", content: systemContext });
    }
    messages.push({ role: "user", content: userContent });

    while (state.step < this.effectiveLimit(state) && state.consecutiveNonActSteps < this.config.noProgressLimit) {
      state.step++;

      this.rebuildSystemMessage(messages, state);

      const turnInput: LlmTurnInput = { messages, tools: allTools };
      this.emitContextSize(clientId, turnInput, state.step, dynamicSystemTokens, staticSystemTokens, resolveModelName);

      const turn = await this.provider.generateTurn(turnInput);

      if (turn.type === "assistant") {
        return { type: "reply", content: turn.content, endStatus: "solved", totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      const calls = turn.calls;
      if (calls.length === 0) {
        return { type: "reply", content: "Empty tool call response.", endStatus: "stuck", totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      const agentStepCall = calls.find((c) => c.name === AGENT_STEP_TOOL_NAME);
      if (!agentStepCall) {
        const result = await this.handleLegacyToolCalls(clientId, state, calls, messages, runHandle);
        if (result) return result;
        continue;
      }

      const parsed = parseAgentStep(agentStepCall.input);
      if (!parsed) {
        messages.push({ role: "assistant_tool_calls", calls: [agentStepCall] });
        messages.push({ role: "tool", toolCallId: agentStepCall.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ error: "Invalid agent_step input. Check required fields." }) });
        continue;
      }

      const phaseResult = await this.routePhase(clientId, state, parsed, agentStepCall, messages, runHandle, realTools);
      if (phaseResult) return phaseResult;
    }

    return {
      type: "reply",
      content: "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.",
      endStatus: "stuck",
      totalSteps: state.step,
      toolCallsMade: state.toolCallsMade,
    };
  }

  private async routePhase(
    clientId: string,
    state: RunState,
    parsed: AgentStepInput,
    call: LlmToolCall,
    messages: LlmMessage[],
    runHandle: MemoryRunHandle,
    realTools: LlmToolSchema[],
  ): Promise<AgentLoopResult | null> {
    messages.push({ role: "assistant_tool_calls", calls: [call] });

    switch (parsed.phase) {
      case "reason": {
        state.scratchpad.push({ step: state.step, phase: "reason", thinking: parsed.thinking, summary: parsed.summary });
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true, step: state.step }) });
        state.consecutiveNonActSteps++;
        return null;
      }

      case "act": {
        const action = parsed.action!;
        const toolResult = await this.executeAction(clientId, state, action.tool_name, action.tool_input, runHandle, realTools);
        const resultStr = formatToolResult(action.tool_name, toolResult);
        state.scratchpad.push({ step: state.step, phase: "act", thinking: parsed.thinking, summary: parsed.summary, toolResult: resultStr });
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: resultStr });
        state.toolCallsMade++;
        state.consecutiveNonActSteps = 0;
        return null;
      }

      case "verify": {
        state.scratchpad.push({ step: state.step, phase: "verify", thinking: parsed.thinking, summary: parsed.summary });
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true }) });
        state.consecutiveNonActSteps++;
        return null;
      }

      case "reflect": {
        if (parsed.approaches_tried) {
          for (const approach of parsed.approaches_tried) {
            state.approachesTried.add(approach);
          }
        }
        state.scratchpad.push({ step: state.step, phase: "reflect", thinking: parsed.thinking, summary: parsed.summary });
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true, approaches_recorded: state.approachesTried.size }) });
        state.consecutiveNonActSteps++;
        return null;
      }

      case "feedback": {
        this.sessionMemory.recordAssistantFeedback(clientId, runHandle.runId, runHandle.sessionId, parsed.feedback_message!);
        this.recordAgentStepEvent(clientId, state, parsed, runHandle);
        return { type: "feedback", content: parsed.feedback_message!, totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      case "end": {
        this.recordAgentStepEvent(clientId, state, parsed, runHandle);
        return { type: "reply", content: parsed.end_message!, endStatus: parsed.end_status, totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      default:
        return null;
    }
  }

  private async executeAction(
    clientId: string,
    state: RunState,
    toolName: string,
    toolInput: unknown,
    runHandle: MemoryRunHandle,
    realTools: LlmToolSchema[],
  ): Promise<ToolResult> {
    const syntheticCall: LlmToolCall = {
      id: `agent-act-${state.step}-${Date.now()}`,
      name: toolName,
      input: toolInput,
    };

    this.sessionMemory.recordToolCall(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      stepId: state.step,
      toolCallId: syntheticCall.id,
      toolName,
      args: toolInput,
    });

    const start = Date.now();
    let result: ToolResult;

    if (toolName === CONTEXT_RECALL_TOOL_NAME) {
      result = await this.executeContextRecall(toolInput, runHandle.sessionId);
    } else if (this.toolExecutor) {
      const isKnown = realTools.some((t) => t.name === toolName);
      if (!isKnown) {
        result = { ok: false, error: `Unknown tool: ${toolName}` };
      } else {
        try {
          result = await this.toolExecutor.execute(toolName, toolInput, { clientId });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : "Unknown tool execution error" };
        }
      }
    } else {
      result = { ok: false, error: `Tool execution unavailable for: ${toolName}` };
    }

    this.sessionMemory.recordToolResult(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      stepId: state.step,
      toolCallId: syntheticCall.id,
      toolName,
      status: result.ok ? "success" : "failed",
      output: result.output ?? "",
      errorMessage: result.error,
      durationMs: Date.now() - start,
    });

    devLog(`Agent ACT step ${state.step}: ${toolName}`);
    return result;
  }

  private async executeContextRecall(input: unknown, activeSessionId?: string): Promise<ToolResult> {
    const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const query = typeof payload["query"] === "string" ? payload["query"].trim() : "";
    if (query.length === 0) {
      return { ok: false, error: "context_recall_agent requires a non-empty `query` string" };
    }

    const searchQuery =
      typeof payload["searchQuery"] === "string" && payload["searchQuery"].trim().length > 0
        ? payload["searchQuery"].trim()
        : undefined;

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const recall = await this.contextRecallService.recall(
      query, memoryContext, activeSessionId,
      { invocationMode: "explicit", ...(searchQuery ? { searchQuery } : {}) },
    );

    const output = {
      status: recall.status,
      reason: recall.reason,
      query,
      searchQuery: searchQuery ?? query,
      searchedSessionIds: recall.searchedSessionIds,
      evidence: recall.evidence,
      evidenceCount: recall.evidence.length,
      modelCalls: recall.modelCalls,
      elapsedMs: recall.elapsedMs,
      foundUsefulData: recall.status === "found" || recall.status === "partial",
    };

    return {
      ok: true,
      output: JSON.stringify(output, null, 2),
      meta: { status: recall.status, evidenceCount: recall.evidence.length, modelCalls: recall.modelCalls },
    };
  }

  private async handleLegacyToolCalls(
    clientId: string,
    state: RunState,
    calls: LlmToolCall[],
    messages: LlmMessage[],
    runHandle: MemoryRunHandle,
  ): Promise<AgentLoopResult | null> {
    messages.push({ role: "assistant_tool_calls", calls });

    for (const call of calls) {
      this.sessionMemory.recordToolCall(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        stepId: state.step,
        toolCallId: call.id,
        toolName: call.name,
        args: call.input,
      });

      const start = Date.now();
      let result: ToolResult;

      if (call.name === CONTEXT_RECALL_TOOL_NAME) {
        result = await this.executeContextRecall(call.input, runHandle.sessionId);
      } else if (this.toolExecutor) {
        try {
          result = await this.toolExecutor.execute(call.name, call.input, { clientId });
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : "Unknown tool execution error" };
        }
      } else {
        result = { ok: false, error: `Tool execution unavailable for: ${call.name}` };
      }

      this.sessionMemory.recordToolResult(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        stepId: state.step,
        toolCallId: call.id,
        toolName: call.name,
        status: result.ok ? "success" : "failed",
        output: result.output ?? "",
        errorMessage: result.error,
        durationMs: Date.now() - start,
      });

      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: formatToolResult(call.name, result) });
      state.toolCallsMade++;
    }

    state.consecutiveNonActSteps = 0;
    return null;
  }

  private recordAgentStepEvent(clientId: string, state: RunState, parsed: AgentStepInput, runHandle: MemoryRunHandle): void {
    this.sessionMemory.recordAgentStep(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      step: state.step,
      phase: parsed.phase,
      summary: parsed.summary,
      approachesTried: [...state.approachesTried],
      actionToolName: parsed.action?.tool_name,
      endStatus: parsed.end_status,
    });
  }

  private effectiveLimit(state: RunState): number {
    return Math.min(
      this.config.baseStepLimit + state.toolCallsMade * this.config.stepLimitPerTool,
      this.config.maxStepLimit,
    );
  }

  private rebuildSystemMessage(messages: LlmMessage[], state: RunState): void {
    if (state.scratchpad.length === 0) return;

    const scratchpadText = buildScratchpadBlock(state.scratchpad, state.approachesTried);
    const firstMsg = messages[0];
    if (firstMsg && firstMsg.role === "system") {
      const baseSystem = firstMsg.content.split("\n--- Scratchpad ---")[0]!.trimEnd();
      firstMsg.content = `${baseSystem}\n\n${scratchpadText}`;
    }
  }

  private emitContextSize(
    clientId: string,
    input: LlmTurnInput,
    step: number,
    dynamicSystemTokens: number,
    staticSystemTokens: number,
    resolveModelName: (providerName: string) => string,
  ): void {
    const estimate = estimateTurnInputTokens(input);
    const runtimeDynamicTokens = Math.max(0, estimate.totalTokens - staticSystemTokens);
    const model = resolveModelName(this.provider.name);

    this.onReply?.(clientId, {
      type: "context_size",
      mode: "local_estimate",
      step,
      provider: this.provider.name,
      model,
      inputTokens: estimate.totalTokens,
      messageTokens: estimate.messageTokens,
      toolSchemaTokens: estimate.toolSchemaTokens,
      staticSystemTokens,
      dynamicSystemTokens,
      runtimeDynamicTokens,
    });

    devLog(
      `Context tokens before model call (step ${step}): ${estimate.totalTokens} ` +
        `[provider=${this.provider.name} model=${model} mode=local_estimate static=${staticSystemTokens} dynamic=${runtimeDynamicTokens}]`,
    );
  }
}
