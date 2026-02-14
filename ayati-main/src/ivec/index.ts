import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import {
  ContextRecallService,
  type ContextRecallOptions,
} from "./context-recall-service.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import { AgentLoop } from "./agent-loop.js";
import { CONTEXT_RECALL_TOOL_NAME } from "./tool-helpers.js";
import type { AgentLoopConfig } from "./agent-loop-types.js";

interface SystemContextBuildResult {
  systemContext: string;
  dynamicSystemTokens: number;
}

export interface IVecEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory?: SessionMemory;
  toolExecutor?: ToolExecutor;
  contextRecall?: ContextRecallOptions;
  contextRecallService?: ContextRecallService;
  loopConfig?: Partial<AgentLoopConfig>;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;
  private readonly contextRecallService: ContextRecallService;
  private readonly loopConfig?: Partial<AgentLoopConfig>;
  private staticSystemTokens = 0;
  private staticTokensReady = false;

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
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
    devLog("IVecEngine started");
  }

  async stop(): Promise<void> {
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("IVecEngine stopped");
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
        const toolDefs = this.toolExecutor?.definitions() ?? [];
        const loop = new AgentLoop(
          this.provider,
          this.toolExecutor,
          this.sessionMemory,
          this.contextRecallService,
          this.onReply,
          this.loopConfig,
          toolDefs,
        );
        const result = await loop.run(
          clientId,
          content,
          system.systemContext,
          system.dynamicSystemTokens,
          runHandle,
          this.staticSystemTokens,
          (providerName) => this.resolveActiveModelName(providerName),
        );

        if (result.type === "reply") {
          this.sessionMemory.recordAssistantFinal(
            clientId,
            runHandle.runId,
            runHandle.sessionId,
            result.content,
          );
          this.onReply?.(clientId, { type: "reply", content: result.content });
        } else if (result.type === "feedback") {
          this.onReply?.(clientId, { type: "feedback_request", content: result.content });
        }
      } else {
        const reply = `Received: "${content}"`;
        this.sessionMemory.recordAssistantFinal(
          clientId,
          runHandle.runId,
          runHandle.sessionId,
          reply,
        );
        this.onReply?.(clientId, { type: "reply", content: reply });
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
      return { systemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const promptInput = assemblePromptInput(this.staticContext, memoryContext);
    const systemContext = buildSystemPrompt({
      ...promptInput,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

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

  private async processToolCall(clientId: string, toolName: string, input: unknown): Promise<void> {
    try {
      const result =
        toolName === CONTEXT_RECALL_TOOL_NAME
          ? await this.executeContextRecallTool(input)
          : this.toolExecutor
              ? await this.toolExecutor.execute(toolName, input, { clientId })
              : { ok: false, error: "Tool execution is not configured." };
      this.onReply?.(clientId, { type: "tool_result", name: toolName, result });
    } catch (err) {
      devError("Tool execution error:", err);
      this.onReply?.(clientId, {
        type: "tool_result",
        name: toolName,
        result: { ok: false, error: "Tool execution failed unexpectedly." },
      });
    }
  }

  private async executeContextRecallTool(input: unknown, activeSessionId?: string): Promise<import("../skills/types.js").ToolResult> {
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
      toolDirectory: this.staticContext.toolDirectory,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const promptTokens = estimateTextTokens(staticOnlyPrompt);

    // Tool schemas are now selected dynamically per step and should be counted at runtime.
    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
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

  private shouldIncludeToolDirectoryInPrompt(): boolean {
    return process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1";
  }
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
