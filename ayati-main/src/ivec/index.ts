import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import { agentLoop } from "./agent-loop.js";
import { buildAutoRotateHandoff } from "./context-pressure.js";
import type { LoopConfig, AgentLoopResult } from "./types.js";

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
  loopConfig?: Partial<LoopConfig>;
  dataDir?: string;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private sessionMemory: SessionMemory;
  private readonly loopConfig?: Partial<LoopConfig>;
  private readonly dataDir?: string;
  private staticSystemTokens = 0;
  private staticTokensReady = false;
  private lastClientId = "";

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
    this.dataDir = options?.dataDir;
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
    };
    if (msg.type === "chat" && typeof msg.content === "string") {
      void this.processChat(clientId, msg.content);
      return;
    }
  }

  private async processChat(clientId: string, content: string): Promise<void> {
    this.lastClientId = clientId;
    let runHandle: MemoryRunHandle | null = null;
    try {
      runHandle = this.sessionMemory.beginRun(clientId, content);
      this.recordTurnStatus(clientId, runHandle, "processing_started");

      if (this.provider) {
        const toolDefs = this.toolExecutor?.definitions() ?? [];
        const system = await this.buildSystemContext();
        const result = await agentLoop({
          provider: this.provider,
          toolExecutor: this.toolExecutor,
          toolDefinitions: toolDefs,
          sessionMemory: this.sessionMemory,
          runHandle,
          clientId,
          config: this.loopConfig,
          dataDir: this.dataDir ?? "data",
          systemContext: system.systemContext || undefined,
          onProgress: (log, runPath) => {
            devLog(`[${clientId}] ${log}`);
            this.sessionMemory.recordAgentStep(clientId, {
              runId: runHandle!.runId,
              sessionId: runHandle!.sessionId,
              step: 0,
              phase: "progress",
              summary: `${log} | runPath: ${runPath}`,
            });
          },
        });
        this.sendAssistantReply(clientId, runHandle, result.content);
      } else {
        const reply = `Received: "${content}"`;
        this.sendAssistantReply(clientId, runHandle, reply);
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
        this.recordTurnStatus(clientId, runHandle, "response_failed", message);
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
    const sessionStatus = this.sessionMemory.getSessionStatus?.() ?? null;

    if (sessionStatus && sessionStatus.contextPercent >= 95 && this.sessionMemory.createSession && this.lastClientId) {
      const handoff = buildAutoRotateHandoff(
        memoryContext.conversationTurns,
        sessionStatus.contextPercent,
        memoryContext.previousSessionSummary,
      );
      this.sessionMemory.createSession(this.lastClientId, {
        runId: "auto-rotate",
        reason: "context_overflow",
        source: "system",
        handoffSummary: handoff,
      });
      devWarn(`Auto-rotated session at ${Math.round(sessionStatus.contextPercent)}% context`);
    }

    const promptInput = assemblePromptInput(this.staticContext, memoryContext, sessionStatus);
    const systemContext = buildSystemPrompt({
      ...promptInput,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const dynamicContext = [
      renderConversationSection(memoryContext.conversationTurns ?? []),
      renderMemorySection(memoryContext.previousSessionSummary ?? ""),
    ]
      .filter((block) => block.trim().length > 0)
      .join("\n\n")
      .trim();

    return {
      systemContext,
      dynamicSystemTokens: estimateTextTokens(dynamicContext),
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
      skillBlocks: this.staticContext.skillBlocks,
      toolDirectory: this.staticContext.toolDirectory,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    const promptTokens = estimateTextTokens(staticOnlyPrompt);

    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
  }

  private shouldIncludeToolDirectoryInPrompt(): boolean {
    return process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1";
  }

  private sendAssistantReply(clientId: string, runHandle: MemoryRunHandle, content: string): void {
    this.recordTurnStatus(clientId, runHandle, "response_started");
    this.sessionMemory.recordAssistantFinal(
      clientId,
      runHandle.runId,
      runHandle.sessionId,
      content,
    );
    this.recordTurnStatus(clientId, runHandle, "response_completed");
    this.onReply?.(clientId, { type: "reply", content });
  }

  private recordTurnStatus(
    clientId: string,
    runHandle: MemoryRunHandle,
    status: "processing_started" | "response_started" | "response_completed" | "response_failed",
    note?: string,
  ): void {
    this.sessionMemory.recordTurnStatus?.(clientId, {
      runId: runHandle.runId,
      sessionId: runHandle.sessionId,
      status,
      note,
    });
  }
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
