import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
  LlmTurnInput,
} from "../core/contracts/llm-protocol.js";
import { noopSessionMemory } from "../memory/provider.js";
import type {
  SessionMemory,
  MemoryRunHandle,
} from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import {
  ContextRecallService,
  type ContextRecallOptions,
} from "./context-recall-service.js";
import {
  estimateTextTokens,
  estimateTurnInputTokens,
} from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolResult } from "../skills/types.js";
import { devLog, devWarn, devError } from "../shared/index.js";

const MAX_TOOL_STEPS = 6;
const CONTEXT_RECALL_TOOL_NAME = "context_recall_agent";

interface SystemContextBuildResult {
  systemContext: string;
  dynamicSystemTokens: number;
}

const CONTEXT_RECALL_TOOL_SCHEMA: LlmToolSchema = {
  name: CONTEXT_RECALL_TOOL_NAME,
  description:
    "Search prior sessions when you need historical context. Call only when active context is insufficient.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What historical context to retrieve from past sessions.",
      },
      searchQuery: {
        type: "string",
        description:
          "Optional compact keyword query to filter candidate sessions in SQLite.",
      },
    },
    required: ["query"],
  },
};

function formatToolResult(toolName: string, result: ToolResult): string {
  return JSON.stringify(
    {
      tool: toolName,
      ok: result.ok,
      output: result.output ?? "",
      error: result.error ?? "",
      meta: result.meta ?? {},
    },
    null,
    2,
  );
}

function toToolSchemas(executor: ToolExecutor | undefined): LlmToolSchema[] {
  const external = executor
    ? executor
        .definitions()
        .filter((tool) => !!tool.inputSchema)
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        }))
    : [];

  if (external.some((tool) => tool.name === CONTEXT_RECALL_TOOL_NAME)) {
    return external;
  }

  return [...external, CONTEXT_RECALL_TOOL_SCHEMA];
}

export interface AgentEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory?: SessionMemory;
  toolExecutor?: ToolExecutor;
  contextRecall?: ContextRecallOptions;
  contextRecallService?: ContextRecallService;
}

export class AgentEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly contextRecallService: ContextRecallService;
  private staticSystemTokens = 0;
  private staticTokensReady = false;

  constructor(options?: AgentEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.contextRecallService =
      options?.contextRecallService ??
      new ContextRecallService(
        this.sessionMemory,
        this.provider,
        options?.contextRecall,
      );
  }

  async start(): Promise<void> {
    if (this.provider) {
      await this.provider.start();
      devLog(`Provider "${this.provider.name}" started`);
    } else {
      devWarn("No LLM provider configured — running in echo mode");
    }

    this.ensureStaticTokenCache();
    devLog("AgentEngine started");
  }

  async stop(): Promise<void> {
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("AgentEngine stopped");
  }

  invalidateStaticTokenCache(): void {
    this.staticTokensReady = false;
  }

  handleMessage(clientId: string, data: unknown): void {
    devLog(`Message from ${clientId}:`, JSON.stringify(data));

    const msg = data as {
      type?: string;
      content?: string;
      name?: string;
      input?: unknown;
    };
    if (msg.type === "chat" && typeof msg.content === "string") {
      void this.processChat(clientId, msg.content);
      return;
    }

    if (msg.type === "tool" && typeof msg.name === "string") {
      void this.processToolCall(clientId, msg.name, msg.input);
    }
  }

  private async processChat(clientId: string, content: string): Promise<void> {
    let runHandle: MemoryRunHandle | null = null;
    try {
      runHandle = this.sessionMemory.beginRun(clientId, content);
      const system = await this.buildSystemContext();

      if (this.provider) {
        const reply = await this.runAutonomousLoop(
          clientId,
          content,
          system.systemContext,
          system.dynamicSystemTokens,
          runHandle,
        );
        this.sessionMemory.recordAssistantFinal(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          reply,
        );
        this.onReply?.(clientId, { type: "reply", content: reply });
      } else {
        const reply = `Received: "${content}"`;
        this.sessionMemory.recordAssistantFinal(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          reply,
        );
        this.onReply?.(clientId, {
          type: "reply",
          content: reply,
        });
      }
    } catch (err) {
      devError("Provider error:", err);
      if (runHandle) {
        const message = err instanceof Error ? err.message : "Unknown runtime failure";
        this.sessionMemory.recordRunFailure(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          message,
        );
      }
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    }
  }

  private async buildSystemContext(): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return {
        systemContext: "",
        dynamicSystemTokens: 0,
      };
    }

    this.ensureStaticTokenCache();

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const promptInput = assemblePromptInput(this.staticContext, memoryContext);
    const systemContext = buildSystemPrompt(promptInput).systemPrompt;

    const dynamicContext = [
      renderConversationSection(memoryContext.conversationTurns ?? []),
      renderMemorySection(
        memoryContext.previousSessionSummary ?? "",
        memoryContext.toolEvents ?? [],
        memoryContext.recalledEvidence ?? [],
        memoryContext.contextRecallStatus,
      ),
    ]
      .filter((block) => block.trim().length > 0)
      .join("\n\n")
      .trim();

    return {
      systemContext,
      dynamicSystemTokens: estimateTextTokens(dynamicContext),
    };
  }

  private async runAutonomousLoop(
    clientId: string,
    userContent: string,
    systemContext: string,
    dynamicSystemTokens: number,
    runHandle: MemoryRunHandle,
  ): Promise<string> {
    if (!this.provider) return `Received: "${userContent}"`;

    const messages: LlmMessage[] = [];
    if (systemContext.trim().length > 0) {
      messages.push({ role: "system", content: systemContext });
    }
    messages.push({ role: "user", content: userContent });
    const tools = toToolSchemas(this.toolExecutor);
    const hasTools = tools.length > 0;

    for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
      const turnInput: LlmTurnInput = {
        messages,
        ...(hasTools ? { tools } : {}),
      };

      this.logContextSizeBeforeRequest(clientId, turnInput, step, dynamicSystemTokens);
      const turn = await this.provider.generateTurn(turnInput);

      if (turn.type === "assistant") {
        return turn.content;
      }

      const calls = turn.calls;
      if (calls.length === 0) {
        return "I received an empty tool call response and could not continue.";
      }

      messages.push({
        role: "assistant_tool_calls",
        calls,
        ...(turn.assistantContent ? { content: turn.assistantContent } : {}),
      });

      for (const call of calls) {
        const result = await this.executeSingleToolCall(
          clientId,
          step,
          call,
          runHandle,
        );
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: formatToolResult(call.name, result),
        });
      }
    }

    return "I couldn't complete the task within the current tool-execution limit.";
  }

  private logContextSizeBeforeRequest(
    clientId: string,
    input: LlmTurnInput,
    step: number,
    dynamicSystemTokens: number,
  ): void {
    const estimate = estimateTurnInputTokens(input);
    const runtimeDynamicTokens = Math.max(0, estimate.totalTokens - this.staticSystemTokens);
    const providerName = this.provider?.name ?? "none";
    const model = this.resolveActiveModelName(providerName);

    this.onReply?.(clientId, {
      type: "context_size",
      mode: "local_estimate",
      step,
      provider: providerName,
      model,
      inputTokens: estimate.totalTokens,
      messageTokens: estimate.messageTokens,
      toolSchemaTokens: estimate.toolSchemaTokens,
      staticSystemTokens: this.staticSystemTokens,
      dynamicSystemTokens,
      runtimeDynamicTokens,
    });

    devLog(
      `Context tokens before model call (step ${step}): ${estimate.totalTokens} ` +
        `[provider=${providerName} model=${model} mode=local_estimate static=${this.staticSystemTokens} dynamic=${runtimeDynamicTokens}]`,
    );
  }

  private async executeSingleToolCall(
    clientId: string,
    step: number,
    call: LlmToolCall,
    runHandle: MemoryRunHandle,
  ): Promise<ToolResult> {
    this.sessionMemory.recordToolCall(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      stepId: step,
      toolCallId: call.id,
      toolName: call.name,
      args: call.input,
    });

    const start = Date.now();

    let result: ToolResult;
    if (call.name === CONTEXT_RECALL_TOOL_NAME) {
      result = await this.executeContextRecallTool(call.input, runHandle.sessionId);
    } else if (this.toolExecutor) {
      try {
        result = await this.toolExecutor.execute(call.name, call.input, { clientId });
      } catch (err) {
        result = {
          ok: false,
          error: err instanceof Error ? err.message : "Unknown tool execution error",
        };
      }
    } else {
      result = { ok: false, error: `Tool execution unavailable for: ${call.name}` };
    }

    this.sessionMemory.recordToolResult(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      stepId: step,
      toolCallId: call.id,
      toolName: call.name,
      status: result.ok ? "success" : "failed",
      output: result.output ?? "",
      errorMessage: result.error,
      errorCode:
        typeof result.meta?.["code"] === "string" ? (result.meta["code"] as string) : undefined,
      durationMs: Date.now() - start,
    });

    devLog(`Autonomous tool call step ${step}: ${call.name}`);
    return result;
  }

  private async processToolCall(clientId: string, toolName: string, input: unknown): Promise<void> {
    try {
      const result =
        toolName === CONTEXT_RECALL_TOOL_NAME
          ? await this.executeContextRecallTool(input)
          : this.toolExecutor
              ? await this.toolExecutor.execute(toolName, input, { clientId })
              : {
                  ok: false,
                  error: "Tool execution is not configured.",
                };
      this.onReply?.(clientId, {
        type: "tool_result",
        name: toolName,
        result,
      });
    } catch (err) {
      devError("Tool execution error:", err);
      this.onReply?.(clientId, {
        type: "tool_result",
        name: toolName,
        result: {
          ok: false,
          error: "Tool execution failed unexpectedly.",
        },
      });
    }
  }

  private async executeContextRecallTool(
    input: unknown,
    activeSessionId?: string,
  ): Promise<ToolResult> {
    const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const query = typeof payload["query"] === "string" ? payload["query"].trim() : "";
    if (query.length === 0) {
      return {
        ok: false,
        error: "context_recall_agent requires a non-empty `query` string",
      };
    }

    const searchQuery =
      typeof payload["searchQuery"] === "string" && payload["searchQuery"].trim().length > 0
        ? payload["searchQuery"].trim()
        : undefined;

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const recall = await this.contextRecallService.recall(
      query,
      memoryContext,
      activeSessionId,
      {
        invocationMode: "explicit",
        ...(searchQuery ? { searchQuery } : {}),
      },
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
      meta: {
        status: recall.status,
        evidenceCount: recall.evidence.length,
        modelCalls: recall.modelCalls,
      },
    };
  }

  private ensureStaticTokenCache(): void {
    if (this.staticTokensReady) return;
    if (!this.staticContext) {
      this.staticSystemTokens = 0;
      this.staticTokensReady = true;
      this.sessionMemory.setStaticTokenBudget(0);
      return;
    }

    const staticOnlyPrompt = buildSystemPrompt({
      basePrompt: this.staticContext.basePrompt,
      soul: this.staticContext.soul,
      userProfile: this.staticContext.userProfile,
      conversationTurns: [],
      previousSessionSummary: "",
      toolEvents: [],
      recalledEvidence: [],
      skillBlocks: this.staticContext.skillBlocks,
    }).systemPrompt;

    const promptTokens = estimateTextTokens(staticOnlyPrompt);
    const toolSchemaTokens = toToolSchemas(this.toolExecutor).reduce(
      (sum, tool) => sum + estimateTextTokens(tool.name) + estimateTextTokens(tool.description) + estimateTextTokens(JSON.stringify(tool.inputSchema)),
      0,
    );

    this.staticSystemTokens = promptTokens + toolSchemaTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens}, toolSchemas=${toolSchemaTokens})`);
  }

  private resolveActiveModelName(providerName: string): string {
    if (providerName === "openai") {
      return process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";
    }
    if (providerName === "anthropic") {
      return process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-5-20250929";
    }
    return "unknown";
  }
}
