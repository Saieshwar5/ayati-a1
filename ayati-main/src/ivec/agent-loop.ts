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
import type {
  AgentLoopConfig,
  AgentLoopConfigInput,
  AgentLoopResult,
  AgentStepInput,
  RunState,
} from "./agent-loop-types.js";
import { DEFAULT_LOOP_CONFIG } from "./agent-loop-types.js";
import type { AgentPlan } from "../memory/agent-working-memory.js";
import { AgentWorkingMemory } from "../memory/agent-working-memory.js";
import type { RunWorkingMemoryWriter } from "../memory/run-working-memory.js";
import type { TaskStateManager } from "../memory/task-state-manager.js";
import {
  AGENT_STEP_TOOL_NAME,
  AGENT_STEP_TOOL_SCHEMA,
  parseAgentStep,
} from "./agent-step-tool.js";
import {
  CREATE_SESSION_TOOL_NAME,
  CREATE_SESSION_TOOL_SCHEMA,
  TASK_CONTROL_TOOL_NAME,
  TASK_CONTROL_TOOL_SCHEMA,
  formatToolResult,
  formatValidationError,
} from "./tool-helpers.js";
import {
  estimateTurnInputTokens,
  type LocalInputTokenEstimate,
} from "../prompt/token-estimator.js";
import { devLog } from "../shared/index.js";

export class AgentLoop {
  private readonly provider: LlmProvider;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly workingMemory: AgentWorkingMemory;
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly config: AgentLoopConfig;
  private readonly runWriter?: RunWorkingMemoryWriter;
  private readonly taskStateManager?: TaskStateManager;

  constructor(
    provider: LlmProvider,
    toolExecutor: ToolExecutor | undefined,
    sessionMemory: SessionMemory,
    workingMemory: AgentWorkingMemory,
    onReply?: (clientId: string, data: unknown) => void,
    config?: AgentLoopConfigInput,
    toolDefinitions?: ToolDefinition[],
    runWriter?: RunWorkingMemoryWriter,
    taskStateManager?: TaskStateManager,
  ) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
    this.sessionMemory = sessionMemory;
    this.workingMemory = workingMemory;
    this.onReply = onReply;
    this.config = {
      ...DEFAULT_LOOP_CONFIG,
      ...config,
    };
    this.toolDefinitions = toolDefinitions ?? [];
    this.runWriter = runWriter;
    this.taskStateManager = taskStateManager;
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
      phaseHistory: [],
      toolCallsMade: 0,
      toolNamesUsed: new Set(),
      failedToolCalls: 0,
      consecutiveNonActSteps: 0,
      consecutiveRepeatedActions: 0,
      errorsByCategory: new Map(),
      hasPlan: false,
      currentSubTaskId: null,
      autoRotated: false,
    };

    const messages: LlmMessage[] = [];
    if (systemContext.trim().length > 0) {
      messages.push({ role: "system", content: systemContext });
    }
    messages.push({ role: "user", content: userContent });

    while (state.step < this.effectiveLimit(state) && state.consecutiveNonActSteps < this.config.noProgressLimit) {
      state.step++;

      const allTools: LlmToolSchema[] = this.buildToolSchemas();
      const turnInput: LlmTurnInput = { messages, tools: allTools };

      const estimate = estimateTurnInputTokens(turnInput);
      const runtimeDynamicTokens = Math.max(0, estimate.totalTokens - staticSystemTokens);
      const dynamicBudget = this.config.contextTokenLimit - staticSystemTokens;
      const contextPct = dynamicBudget > 0
        ? Math.round((runtimeDynamicTokens / dynamicBudget) * 100)
        : 100;

      this.autoRotateSessionIfNeeded(clientId, runHandle, contextPct, messages, state);

      const signals = this.generateStateSignals(state, contextPct);
      this.rebuildSystemMessage(messages, signals);

      this.emitContextSize(clientId, estimate, state.step, dynamicSystemTokens, staticSystemTokens, resolveModelName);

      const turn = await this.provider.generateTurn(turnInput);

      if (turn.type === "assistant") {
        return this.finalizeRun({ type: "reply", content: turn.content, endStatus: "solved", totalSteps: state.step, toolCallsMade: state.toolCallsMade }, state);
      }

      const calls = turn.calls;
      if (calls.length === 0) {
        return this.finalizeRun({ type: "reply", content: "Empty tool call response.", endStatus: "stuck", totalSteps: state.step, toolCallsMade: state.toolCallsMade }, state);
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
        );
        if (phaseResult) return this.finalizeRun(phaseResult, state);
      }

      if (directCalls.length > 0) {
        await this.handleDirectToolCalls(
          clientId,
          state,
          directCalls,
          messages,
          runHandle,
        );
      }

      if (!agentStepCall && directCalls.length === 0) {
        return this.finalizeRun({ type: "reply", content: "Empty tool call response.", endStatus: "stuck", totalSteps: state.step, toolCallsMade: state.toolCallsMade }, state);
      }
    }

    return this.finalizeRun({
      type: "reply",
      content: "I've exhausted my reasoning steps. Here's what I found so far based on my analysis.",
      endStatus: "stuck",
      totalSteps: state.step,
      toolCallsMade: state.toolCallsMade,
    }, state);
  }

  private async routePhase(
    clientId: string,
    state: RunState,
    parsed: AgentStepInput,
    call: LlmToolCall,
    messages: LlmMessage[],
    runHandle: MemoryRunHandle,
  ): Promise<AgentLoopResult | null> {
    messages.push({ role: "assistant_tool_calls", calls: [call] });

    switch (parsed.phase) {
      case "reason": {
        const reasonStep = { step: state.step, phase: "reason", thinking: parsed.thinking, summary: parsed.summary };
        this.workingMemory.addStep(reasonStep);
        this.runWriter?.writeStep(reasonStep);
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true, step: state.step }) });
        state.consecutiveNonActSteps++;
        state.phaseHistory.push("reason");
        return null;
      }

      case "plan": {
        if (!parsed.plan) {
          messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ error: "plan phase requires a plan object" }) });
          state.consecutiveNonActSteps++;
          state.phaseHistory.push("plan");
          return null;
        }
        const agentPlan: AgentPlan = {
          goal: parsed.plan.goal,
          sub_tasks: parsed.plan.sub_tasks.map((st) => ({
            ...st,
            status: "pending" as const,
          })),
          current_sub_task: parsed.plan.sub_tasks[0]?.id ?? 1,
          plan_version: (this.workingMemory.plan?.plan_version ?? 0) + 1,
        };
        this.workingMemory.setPlan(agentPlan);
        this.runWriter?.writePlan(agentPlan);
        const planStep = { step: state.step, phase: "plan", thinking: parsed.thinking, summary: parsed.summary };
        this.workingMemory.addStep(planStep);
        this.runWriter?.writeStep(planStep);
        state.hasPlan = true;
        state.currentSubTaskId = agentPlan.current_sub_task;
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true, plan_version: agentPlan.plan_version, sub_tasks: agentPlan.sub_tasks.length }) });
        state.consecutiveNonActSteps++;
        state.phaseHistory.push("plan");
        return null;
      }

      case "act": {
        const action = parsed.action!;
        const toolResult = await this.executeAction(
          clientId,
          state,
          action.tool_name,
          action.tool_input,
          runHandle,
        );
        const resultStr = formatToolResult(action.tool_name, toolResult);

        const actStep = {
          step: state.step,
          phase: "act",
          thinking: parsed.thinking,
          summary: parsed.summary,
          toolName: action.tool_name,
          toolInput: action.tool_input,
          toolOutput: resultStr,
          toolStatus: toolResult.ok ? "success" : "failed" as "success" | "failed",
        };
        this.workingMemory.addStep(actStep);
        this.runWriter?.writeStep(actStep);

        if (!toolResult.ok) {
          this.workingMemory.addError({
            step: state.step,
            toolName: action.tool_name,
            errorMessage: toolResult.error ?? "unknown error",
            resolved: false,
          });
          const category = this.categorizeToolError(toolResult.error ?? "");
          state.errorsByCategory.set(category, (state.errorsByCategory.get(category) ?? 0) + 1);
        }

        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: resultStr });
        state.toolCallsMade++;
        state.consecutiveNonActSteps = 0;
        state.phaseHistory.push("act");
        return null;
      }

      case "verify": {
        if (parsed.key_facts && parsed.key_facts.length > 0) {
          const lastActStep = [...this.workingMemory.steps].reverse().find((s) => s.phase === "act");
          const newFacts = parsed.key_facts.map((fact) => ({
            fact,
            sourceStep: state.step,
            sourceToolName: lastActStep?.toolName,
          }));
          this.workingMemory.addKeyFacts(newFacts);
          for (const f of newFacts) {
            this.runWriter?.writeKeyFact(f);
          }
        }
        if (parsed.sub_task_outcome && state.currentSubTaskId !== null) {
          this.workingMemory.updateSubTaskStatus(state.currentSubTaskId, parsed.sub_task_outcome);
          this.runWriter?.updateSubTaskStatus(state.currentSubTaskId, parsed.sub_task_outcome);
          if (parsed.sub_task_outcome === "done") {
            const nextId = this.workingMemory.advanceToNextSubTask();
            state.currentSubTaskId = nextId;
          }
        }
        const verifyStep = { step: state.step, phase: "verify", thinking: parsed.thinking, summary: parsed.summary };
        this.workingMemory.addStep(verifyStep);
        this.runWriter?.writeStep(verifyStep);
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true, facts_recorded: parsed.key_facts?.length ?? 0, sub_task_outcome: parsed.sub_task_outcome ?? null }) });
        state.consecutiveNonActSteps++;
        state.phaseHistory.push("verify");
        return null;
      }

      case "reflect": {
        const lastUnresolved = [...this.workingMemory.errorRegister].reverse().find((e) => !e.resolved);
        if (lastUnresolved) {
          this.workingMemory.resolveError(lastUnresolved.step, parsed.summary);
          this.runWriter?.writeErrorResolved(lastUnresolved.step, parsed.summary);
        }
        const reflectStep = { step: state.step, phase: "reflect", thinking: parsed.thinking, summary: parsed.summary };
        this.workingMemory.addStep(reflectStep);
        this.runWriter?.writeStep(reflectStep);
        messages.push({ role: "tool", toolCallId: call.id, name: AGENT_STEP_TOOL_NAME, content: JSON.stringify({ acknowledged: true }) });
        state.consecutiveNonActSteps++;
        state.phaseHistory.push("reflect");
        return null;
      }

      case "feedback": {
        this.runWriter?.writeStep({ step: state.step, phase: "feedback", thinking: parsed.thinking, summary: parsed.feedback_message ?? "" });
        this.sessionMemory.recordAssistantFeedback(clientId, runHandle.runId, runHandle.sessionId, parsed.feedback_message!);
        this.recordAgentStepEvent(clientId, state, parsed, runHandle);
        return { type: "feedback", content: parsed.feedback_message!, totalSteps: state.step, toolCallsMade: state.toolCallsMade };
      }

      case "end": {
        const endStep = { step: state.step, phase: "end", thinking: parsed.thinking, summary: parsed.end_message ?? "" };
        this.workingMemory.addStep(endStep);
        this.runWriter?.writeStep(endStep);
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
  ): Promise<void> {
    messages.push({ role: "assistant_tool_calls", calls });

    for (const call of calls) {
      const toolResult = await this.executeAction(
        clientId,
        state,
        call.name,
        call.input,
        runHandle,
      );
      const resultStr = formatToolResult(call.name, toolResult);

      this.workingMemory.addStep({
        step: state.step,
        phase: "act",
        thinking: `Direct tool call: ${call.name}`,
        summary: `Execute ${call.name}`,
        toolName: call.name,
        toolInput: call.input,
        toolOutput: resultStr,
        toolStatus: toolResult.ok ? "success" : "failed",
      });

      if (!toolResult.ok) {
        this.workingMemory.addError({
          step: state.step,
          toolName: call.name,
          errorMessage: toolResult.error ?? "unknown error",
          resolved: false,
        });
        const category = this.categorizeToolError(toolResult.error ?? "");
        state.errorsByCategory.set(category, (state.errorsByCategory.get(category) ?? 0) + 1);
      }

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
  ): Promise<ToolResult> {
    const syntheticCall: LlmToolCall = {
      id: `agent-act-${state.step}-${Date.now()}`,
      name: toolName,
      input: toolInput,
    };
    state.toolNamesUsed.add(toolName);

    const start = Date.now();
    let result: ToolResult;
    const signature = this.buildActionSignature(toolName, toolInput);

    if (state.lastActionSignature === signature) {
      state.consecutiveRepeatedActions += 1;
    } else {
      state.lastActionSignature = signature;
      state.consecutiveRepeatedActions = 1;
    }

    const isSessionSwitchTool = toolName === CREATE_SESSION_TOOL_NAME;
    const isTaskControlTool = toolName === TASK_CONTROL_TOOL_NAME;
    const deferToolCallRecord = isSessionSwitchTool || isTaskControlTool;
    if (!deferToolCallRecord) {
      this.sessionMemory.recordToolCall(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        stepId: state.step,
        toolCallId: syntheticCall.id,
        toolName,
        args: toolInput,
      });
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
    } else if (isTaskControlTool) {
      result = this.executeTaskControl(clientId, toolInput, runHandle);
    } else if (isSessionSwitchTool) {
      result = this.executeCreateSession(clientId, toolInput, runHandle);
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

    if (!result.ok) {
      state.failedToolCalls++;
    }

    if (deferToolCallRecord) {
      this.sessionMemory.recordToolCall(clientId, {
        runId: runHandle.runId,
        sessionId: runHandle.sessionId,
        stepId: state.step,
        toolCallId: syntheticCall.id,
        toolName,
        args: toolInput,
      });
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

  private executeCreateSession(
    clientId: string,
    input: unknown,
    runHandle: MemoryRunHandle,
  ): ToolResult {
    const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const reason = typeof payload["reason"] === "string" ? payload["reason"].trim() : "";
    const confidence = typeof payload["confidence"] === "number" && Number.isFinite(payload["confidence"])
      ? payload["confidence"]
      : undefined;
    const agentHandoff = typeof payload["handoff_summary"] === "string" && payload["handoff_summary"].trim().length > 0
      ? payload["handoff_summary"].trim()
      : undefined;
    if (reason.length === 0) {
      return { ok: false, error: "create_session requires a non-empty `reason` string" };
    }

    const createSession = this.sessionMemory.createSession;
    if (!createSession) {
      return { ok: false, error: "create_session is unavailable in the active session memory implementation" };
    }

    // Auto-attach working memory state to the handoff.
    const workingMemoryState = this.workingMemory.renderView();
    const handoffSummary = agentHandoff
      ? `${agentHandoff}\n\n---\n[Working Memory at session switch]\n${workingMemoryState}`
      : `[Working Memory at session switch]\n${workingMemoryState}`;

    const created = createSession.call(this.sessionMemory, clientId, {
      runId: runHandle.runId,
      reason,
      source: "agent",
      confidence,
      handoffSummary,
    });

    return {
      ok: true,
      output: JSON.stringify(
        {
          status: "session_created",
          reason,
          confidence,
          handoffSummary,
          previousSessionId: created.previousSessionId,
          sessionId: created.sessionId,
          sessionPath: created.sessionPath,
        },
        null,
        2,
      ),
      meta: {
        sessionCreated: true,
        previousSessionId: created.previousSessionId,
        sessionId: created.sessionId,
      },
    };
  }

  private executeTaskControl(
    clientId: string,
    input: unknown,
    runHandle: MemoryRunHandle,
  ): ToolResult {
    if (!this.taskStateManager) {
      return { ok: false, error: "Task management is not configured." };
    }
    const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const action = typeof payload["action"] === "string" ? payload["action"] : "";

    if (action === "start") {
      const goal = typeof payload["goal"] === "string" ? payload["goal"].trim() : "";
      const rawSubTasks = Array.isArray(payload["subtasks"]) ? payload["subtasks"] : [];
      if (!goal) return { ok: false, error: "task_control start requires 'goal'" };
      if (rawSubTasks.length === 0) return { ok: false, error: "task_control start requires at least one subtask" };
      const subTasks = (rawSubTasks as Array<Record<string, unknown>>).map((st) => ({
        id: typeof st["id"] === "number" ? st["id"] : 0,
        title: typeof st["title"] === "string" ? st["title"] : "Unnamed",
        depends_on: Array.isArray(st["depends_on"]) ? (st["depends_on"] as number[]) : undefined,
      }));
      const state = this.taskStateManager.createTask(clientId, goal, subTasks);
      return {
        ok: true,
        output: JSON.stringify({ task_id: state.taskId, status: "task_created", total_subtasks: state.subTasks.length, first_subtask: state.subTasks[0]?.title }),
        meta: { taskCreated: true, taskId: state.taskId },
      };
    }

    if (action === "complete_subtask") {
      const taskId = typeof payload["task_id"] === "string" ? payload["task_id"] : "";
      const subtaskId = typeof payload["subtask_id"] === "number" ? payload["subtask_id"] : -1;
      const handoff = typeof payload["handoff"] === "string" ? payload["handoff"].trim() : "";
      if (!taskId) return { ok: false, error: "task_control complete_subtask requires 'task_id'" };
      if (subtaskId < 0) return { ok: false, error: "task_control complete_subtask requires 'subtask_id'" };
      if (!handoff) return { ok: false, error: "task_control complete_subtask requires 'handoff' (2-3 sentences)" };
      // Rotate session for GC
      this.executeCreateSession(clientId, { reason: `subtask_${subtaskId}_complete`, handoff_summary: handoff }, runHandle);
      const notesPath = this.taskStateManager.getSubTaskNotesPath(taskId, subtaskId);
      const next = this.taskStateManager.completeSubTask(clientId, taskId, subtaskId, notesPath);
      return {
        ok: true,
        output: JSON.stringify({ completed_subtask: subtaskId, next_subtask: next.nextSubTaskId, next_title: next.nextSubTaskTitle }),
        meta: { subtaskCompleted: subtaskId, nextSubTaskId: next.nextSubTaskId },
      };
    }

    if (action === "finish") {
      const taskId = typeof payload["task_id"] === "string" ? payload["task_id"] : "";
      if (!taskId) return { ok: false, error: "task_control finish requires 'task_id'" };
      this.taskStateManager.finishTask(clientId, taskId);
      return { ok: true, output: JSON.stringify({ status: "task_complete", task_id: taskId }) };
    }

    return { ok: false, error: `Unknown task_control action: '${action}'. Use 'start', 'complete_subtask', or 'finish'.` };
  }

  private recordAgentStepEvent(
    clientId: string,
    state: RunState,
    parsed: AgentStepInput,
    runHandle: MemoryRunHandle,
  ): void {
    this.sessionMemory.recordAgentStep(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      step: state.step,
      phase: parsed.phase,
      summary: parsed.summary,
      actionToolName: parsed.action?.tool_name,
      endStatus: parsed.end_status,
    });
  }

  private finalizeRun(result: AgentLoopResult, state: RunState): AgentLoopResult {
    if (!this.runWriter) return result;
    const digest = this.runWriter.finalize(
      result.endStatus ?? "stuck",
      state.step,
      state.toolCallsMade,
      result.content,
      this.workingMemory,
    );
    return { ...result, workingMemoryPath: digest.filePath, runDigest: digest };
  }

  private effectiveLimit(state: RunState): number {
    return Math.min(
      this.config.baseStepLimit + state.toolCallsMade * this.config.stepLimitPerTool,
      this.config.maxStepLimit,
    );
  }

  private rebuildSystemMessage(messages: LlmMessage[], signals: string): void {
    const hasWorkingMemory = this.workingMemory.steps.length > 0 || this.workingMemory.plan !== null;
    const hasSignals = signals.trim().length > 0;
    if (!hasWorkingMemory && !hasSignals) return;

    const view = this.workingMemory.renderView(signals);
    const firstMsg = messages[0];
    if (firstMsg && firstMsg.role === "system") {
      const base = firstMsg.content.split("\n--- Agent Working Memory ---")[0]!.trimEnd();
      firstMsg.content = `${base}\n\n${view}`;
    }
  }

  private generateStateSignals(state: RunState, contextPct: number): string {
    const signals: string[] = [];
    const budget = this.effectiveLimit(state);
    signals.push(`ℹ ${state.step} of ${budget} steps used`);

    if (contextPct >= 90) {
      signals.push(`⚠ CONTEXT: ${contextPct}% — switch session now or auto-rotation will trigger`);
    } else if (contextPct >= 70) {
      signals.push(`⚠ Context: ${contextPct}% — consider create_session at a natural stopping point`);
    } else if (contextPct >= 50) {
      signals.push(`ℹ Context: ${contextPct}% dynamic budget used`);
    }

    if (state.failedToolCalls >= 1) {
      signals.push("⚠ Last tool call failed. You MUST use phase='reflect' to diagnose the cause before acting again. Do not repeat the same tool_input.");
    }
    if (state.failedToolCalls >= 2 && state.consecutiveRepeatedActions >= 2) {
      signals.push("⚠ CRITICAL: Same action failed multiple times. Reflect now — do NOT act until you have a genuinely different approach.");
    }
    if (state.consecutiveNonActSteps >= 3) {
      signals.push("⚠ 3 steps without action. Act, reflect, or ask the user.");
    }
    const permErrors = state.errorsByCategory.get("permission") ?? 0;
    if (permErrors >= 2) {
      signals.push("⚠ Multiple permission errors. Try a different approach.");
    }

    return signals.join("\n");
  }

  private categorizeToolError(errorMessage: string): string {
    const msg = errorMessage.toLowerCase();
    if (msg.includes("not found") || msg.includes("no such")) return "not_found";
    if (msg.includes("permission") || msg.includes("denied")) return "permission";
    if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
    if (msg.includes("invalid") || msg.includes("validation")) return "invalid_input";
    return "runtime";
  }

  private emitContextSize(
    clientId: string,
    estimate: LocalInputTokenEstimate,
    step: number,
    dynamicSystemTokens: number,
    staticSystemTokens: number,
    resolveModelName: (providerName: string) => string,
  ): void {
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

  private autoRotateSessionIfNeeded(
    clientId: string,
    runHandle: MemoryRunHandle,
    contextPct: number,
    messages: LlmMessage[],
    state: RunState,
  ): void {
    if (state.autoRotated) return;
    if (contextPct < this.config.autoRotateThreshold) return;

    const result = this.executeCreateSession(clientId, {
      reason: `auto_context_rotation_${contextPct}pct`,
      handoff_summary: `[AUTO-ROTATED at ${contextPct}% context]`,
    }, runHandle);

    state.autoRotated = true;

    if (result.ok) {
      messages.push({
        role: "tool",
        toolCallId: `auto-rotate-${Date.now()}`,
        name: "system",
        content: `Session auto-rotated at ${contextPct}% context. ` +
                 `Previous plan and key facts preserved in session summary. Continue your work.`,
      });
    }
  }

  private buildToolSchemas(): LlmToolSchema[] {
    const toolDefs = this.toolDefinitions.length > 0
      ? this.toolDefinitions
      : (this.toolExecutor?.definitions() ?? []);

    const catalog = toolDefs.map((tool) => {
      const schema = tool.inputSchema;
      const props = schema?.["properties"] as Record<string, { type?: string }> | undefined;
      const required = (schema?.["required"] as string[] | undefined) ?? [];

      const fields = props
        ? Object.entries(props)
            .map(([key, val]) => `${key}: ${val.type ?? "any"}${required.includes(key) ? " (required)" : " (optional)"}`)
            .join(", ")
        : "no parameters";

      return `  - ${tool.name}: { ${fields} }`;
    }).join("\n");

    const enrichedAgentStep: LlmToolSchema = {
      ...AGENT_STEP_TOOL_SCHEMA,
      description:
        AGENT_STEP_TOOL_SCHEMA.description +
        (catalog.length > 0
          ? `\n\nWhen phase is 'act', set action.tool_name to one of the tools below and action.tool_input with ALL required fields. Never send an empty tool_input object.\n\nAvailable tools:\n${catalog}`
          : ""),
    };

    const tools: LlmToolSchema[] = [enrichedAgentStep, CREATE_SESSION_TOOL_SCHEMA];
    if (this.taskStateManager) tools.push(TASK_CONTROL_TOOL_SCHEMA);
    return tools;
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
}
