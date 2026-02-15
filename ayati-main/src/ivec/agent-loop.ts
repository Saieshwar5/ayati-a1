import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
  LlmTurnInput,
} from "../core/contracts/llm-protocol.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolDefinition, ToolResult } from "../skills/types.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { ContextRecallService } from "./context-recall-service.js";
import type {
  AgentLoopConfig,
  AgentLoopConfigInput,
  AgentLoopEscalationDetails,
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
  CONTEXT_RECALL_TOOL_SCHEMA,
  formatToolResult,
  formatValidationError,
} from "./tool-helpers.js";
import {
  estimateTurnInputTokens,
} from "../prompt/token-estimator.js";
import { devLog } from "../shared/index.js";
import { canUseTool } from "../skills/access-policy.js";
import { selectTools } from "../tools/selector.js";
import type { SelectableTool } from "../tools/selector-types.js";

interface TurnToolSelection {
  tools: LlmToolSchema[];
  allowedToolNames: Set<string>;
}

export class AgentLoop {
  private readonly provider: LlmProvider;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly contextRecallService: ContextRecallService;
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly config: AgentLoopConfig;

  constructor(
    provider: LlmProvider,
    toolExecutor: ToolExecutor | undefined,
    sessionMemory: SessionMemory,
    contextRecallService: ContextRecallService,
    onReply?: (clientId: string, data: unknown) => void,
    config?: AgentLoopConfigInput,
    toolDefinitions?: ToolDefinition[],
  ) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
    this.sessionMemory = sessionMemory;
    this.contextRecallService = contextRecallService;
    this.onReply = onReply;
    this.config = {
      ...DEFAULT_LOOP_CONFIG,
      ...config,
      toolSelection: {
        ...DEFAULT_LOOP_CONFIG.toolSelection,
        ...(config?.toolSelection ?? {}),
      },
      escalation: {
        ...DEFAULT_LOOP_CONFIG.escalation,
        ...(config?.escalation ?? {}),
      },
    };
    this.toolDefinitions = toolDefinitions ?? [];
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
    if (!this.provider.capabilities.nativeToolCalling) {
      throw new Error(`Provider '${this.provider.name}' does not support native tool calling.`);
    }

    const state: RunState = {
      step: 0,
      scratchpad: [],
      approachesTried: new Set(),
      toolCallsMade: 0,
      toolNamesUsed: new Set(),
      failedToolCalls: 0,
      reflectCycles: 0,
      consecutiveNonActSteps: 0,
      forceExpandedSelectionNextStep: false,
      consecutiveRepeatedActions: 0,
    };

    const messages: LlmMessage[] = [];
    if (systemContext.trim().length > 0) {
      messages.push({ role: "system", content: systemContext });
    }
    messages.push({ role: "user", content: userContent });

    while (state.step < this.effectiveLimit(state) && state.consecutiveNonActSteps < this.config.noProgressLimit) {
      state.step++;

      this.rebuildSystemMessage(messages, state);

      const selection = this.selectTurnTools(userContent, state);
      const allTools: LlmToolSchema[] = [AGENT_STEP_TOOL_SCHEMA, ...selection.tools];

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
      const directCalls = calls.filter((c) => c.name !== AGENT_STEP_TOOL_NAME);

      if (agentStepCall) {
        const parsed = parseAgentStep(agentStepCall.input);
        if (!parsed) {
          messages.push({ role: "assistant_tool_calls", calls: [agentStepCall] });
          messages.push({ role: "tool", toolCallId: agentStepCall.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ error: "Invalid agent_step input. Check required fields." }) });
          continue;
        }

        const phaseResult = await this.routePhase(
          clientId,
          state,
          parsed,
          agentStepCall,
          messages,
          runHandle,
          selection.allowedToolNames,
        );
        if (phaseResult) return phaseResult;
      }

      if (directCalls.length > 0) {
        await this.handleDirectToolCalls(
          clientId,
          state,
          directCalls,
          messages,
          runHandle,
          selection.allowedToolNames,
        );
      }

      if (!agentStepCall && directCalls.length === 0) {
        return { type: "reply", content: "Empty tool call response.", endStatus: "stuck", totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      const escalation = this.evaluateEscalation(state);
      if (escalation) {
        this.sessionMemory.recordAgentStep(clientId, {
          runId: runHandle.runId,
          sessionId: runHandle.sessionId,
          step: state.step,
          phase: "escalate",
          summary: escalation.summary,
          approachesTried: [...state.approachesTried],
          endStatus: "partial",
        });
        return {
          type: "escalate",
          content: escalation.summary,
          endStatus: "partial",
          totalSteps: state.step,
          toolCallsMade: state.toolCallsMade,
          escalation,
        };
      }
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
    allowedToolNames: Set<string>,
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
        const toolResult = await this.executeAction(clientId, state, action.tool_name, action.tool_input, runHandle, allowedToolNames);
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
        state.reflectCycles++;
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

  private async handleDirectToolCalls(
    clientId: string,
    state: RunState,
    calls: LlmToolCall[],
    messages: LlmMessage[],
    runHandle: MemoryRunHandle,
    allowedToolNames: Set<string>,
  ): Promise<void> {
    messages.push({ role: "assistant_tool_calls", calls });

    for (const call of calls) {
      const toolResult = await this.executeAction(clientId, state, call.name, call.input, runHandle, allowedToolNames);
      const resultStr = formatToolResult(call.name, toolResult);
      state.scratchpad.push({ step: state.step, phase: "act", thinking: `Direct tool call: ${call.name}`, summary: `Execute ${call.name}`, toolResult: resultStr });
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: resultStr });
      state.toolCallsMade++;
      state.consecutiveNonActSteps = 0;
    }
  }

  private async executeAction(
    clientId: string,
    state: RunState,
    toolName: string,
    toolInput: unknown,
    runHandle: MemoryRunHandle,
    allowedToolNames: Set<string>,
  ): Promise<ToolResult> {
    const syntheticCall: LlmToolCall = {
      id: `agent-act-${state.step}-${Date.now()}`,
      name: toolName,
      input: toolInput,
    };
    state.toolNamesUsed.add(toolName);

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
    const signature = this.buildActionSignature(toolName, toolInput);

    if (state.lastActionSignature === signature) {
      state.consecutiveRepeatedActions += 1;
    } else {
      state.lastActionSignature = signature;
      state.consecutiveRepeatedActions = 1;
    }

    if (state.consecutiveRepeatedActions > this.config.repeatedActionLimit) {
      result = {
        ok: false,
        error: `Blocked repeated identical tool call for '${toolName}'. Try a different strategy.`,
        meta: {
          repeatedActionBlocked: true,
          repeatedCount: state.consecutiveRepeatedActions,
          repeatedActionLimit: this.config.repeatedActionLimit,
        },
      };
    } else if (!allowedToolNames.has(toolName)) {
      result = {
        ok: false,
        error: this.formatSelectionError(toolName, allowedToolNames),
        meta: {
          selectionMiss: true,
          availableTools: [...allowedToolNames].filter((name) => name !== AGENT_STEP_TOOL_NAME),
        },
      };
    } else if (toolName === CONTEXT_RECALL_TOOL_NAME) {
      result = await this.executeContextRecall(toolInput, runHandle.sessionId);
    } else if (this.toolExecutor) {
      const validation = this.toolExecutor.validate(toolName, toolInput);
      if (!validation.valid) {
        result = {
          ok: false,
          error: formatValidationError(
            toolName,
            validation.error ?? "invalid input",
            validation.schema as Record<string, unknown> | undefined,
          ),
        };
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

    if (this.isSelectionMiss(result)) {
      state.forceExpandedSelectionNextStep = true;
    }
    if (!result.ok) {
      state.failedToolCalls++;
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

  private evaluateEscalation(state: RunState): AgentLoopEscalationDetails | null {
    if (!this.config.escalation.enabled) return null;

    const distinctTools = state.toolNamesUsed.size;
    const minCallsReached = state.toolCallsMade > this.config.escalation.minToolCalls;
    const toolDiversityReached = distinctTools >= this.config.escalation.minDistinctTools;

    const weakConvergence =
      state.failedToolCalls >= this.config.escalation.minFailedToolCalls ||
      state.reflectCycles >= this.config.escalation.minReflectCycles;

    if (!minCallsReached || !toolDiversityReached || !weakConvergence) {
      return null;
    }

    const toolNames = [...state.toolNamesUsed].sort((a, b) => a.localeCompare(b));
    return {
      reason: "tool_volume_and_diversity_with_low_progress",
      summary:
        "Escalating to maximum mode: " +
        `${state.toolCallsMade} tool call(s), ${toolNames.length} tool type(s), ` +
        `${state.failedToolCalls} failed call(s), ${state.reflectCycles} reflect cycle(s).`,
      toolNamesUsed: toolNames,
      failedToolCalls: state.failedToolCalls,
      reflectCycles: state.reflectCycles,
    };
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

  private selectTurnTools(userContent: string, state: RunState): TurnToolSelection {
    const available = this.buildSelectableTools();
    if (available.length === 0) {
      return { tools: [], allowedToolNames: new Set() };
    }

    if (!this.config.toolSelection.enabled) {
      const schemas = available.map((tool) => tool.schema);
      return {
        tools: schemas,
        allowedToolNames: new Set(schemas.map((tool) => tool.name)),
      };
    }

    const query = this.buildSelectionQuery(userContent, state);
    const topK = state.forceExpandedSelectionNextStep
      ? this.config.toolSelection.retryTopK
      : this.config.toolSelection.topK;

    const selection = selectTools({
      query,
      tools: available,
      topK,
      alwaysInclude: [
        ...this.config.toolSelection.alwaysInclude,
        CONTEXT_RECALL_TOOL_NAME,
      ],
    });

    state.forceExpandedSelectionNextStep = false;

    const selected = selection.selected.length > 0
      ? selection.selected
      : available;

    const schemas = selected.map((tool) => tool.schema);
    return {
      tools: schemas,
      allowedToolNames: new Set(schemas.map((tool) => tool.name)),
    };
  }

  private buildSelectableTools(): SelectableTool[] {
    const selectable: SelectableTool[] = [];
    const toolDefs = this.toolDefinitions.length > 0
      ? this.toolDefinitions
      : (this.toolExecutor?.definitions() ?? []);

    for (const tool of toolDefs) {
      if (!canUseTool(tool.name).allowed) continue;
      selectable.push({
        schema: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object" },
        },
        hints: tool.selectionHints,
      });
    }

    if (canUseTool(CONTEXT_RECALL_TOOL_NAME).allowed) {
      selectable.push({
        schema: CONTEXT_RECALL_TOOL_SCHEMA,
        hints: {
          tags: ["memory", "history", "context", "recall"],
          aliases: ["search_history", "previous_sessions"],
          examples: ["what did we discuss before"],
          domain: "memory",
          priority: 1,
        },
      });
    }

    return selectable;
  }

  private buildSelectionQuery(userContent: string, state: RunState): string {
    const scratchpadSummary = state.scratchpad
      .slice(-4)
      .map((entry) => `${entry.phase} ${entry.summary}`)
      .join(" ");

    return [userContent, scratchpadSummary]
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n")
      .trim();
  }

  private isSelectionMiss(result: ToolResult): boolean {
    if (!result.meta || typeof result.meta !== "object") return false;
    return result.meta["selectionMiss"] === true || result.meta["repeatedActionBlocked"] === true;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    const entries = keys.map((key) => `${JSON.stringify(key)}:${this.stableStringify(obj[key])}`);
    return `{${entries.join(",")}}`;
  }

  private buildActionSignature(toolName: string, toolInput: unknown): string {
    return `${toolName}::${this.stableStringify(toolInput)}`;
  }

  private formatSelectionError(toolName: string, allowedToolNames: Set<string>): string {
    const availableTools = [...allowedToolNames]
      .filter((name) => name !== AGENT_STEP_TOOL_NAME)
      .sort((a, b) => a.localeCompare(b));

    const prefix = `Tool '${toolName}' is not available in this step's selected tool set.`;
    if (availableTools.length === 0) {
      return `${prefix} No executable tools are currently exposed.`;
    }

    const shown = availableTools.slice(0, 20);
    const suffix = availableTools.length > shown.length
      ? ` (showing ${shown.length}/${availableTools.length})`
      : "";
    return `${prefix} Available tools${suffix}: ${shown.join(", ")}`;
  }
}
