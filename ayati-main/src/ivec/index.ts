import type { LlmProvider } from "../core/contracts/provider.js";
import { noopSessionMemory } from "../memory/provider.js";
import { AgentWorkingMemory } from "../memory/agent-working-memory.js";
import { RunWorkingMemoryWriter } from "../memory/run-working-memory.js";
import type { RunDigest } from "../memory/run-working-memory.js";
import { TaskStateManager } from "../memory/task-state-manager.js";
import type { SessionMemory, MemoryRunHandle } from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import { renderConversationSection } from "../prompt/sections/conversation.js";
import { renderMemorySection } from "../prompt/sections/memory.js";
import { renderLastRunSection } from "../prompt/sections/last-run.js";
import { renderTaskContextSection } from "../prompt/sections/task-context.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import { AgentLoop } from "./agent-loop.js";
import type { AgentLoopConfigInput } from "./agent-loop-types.js";

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
  loopConfig?: AgentLoopConfigInput;
  dataDir?: string;
}

export class IVecEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private sessionMemory: SessionMemory;
  private readonly loopConfig?: AgentLoopConfigInput;
  private readonly dataDir?: string;
  private readonly taskStateManager?: TaskStateManager;
  private readonly lastRunDigests = new Map<string, RunDigest>();
  private staticSystemTokens = 0;
  private staticTokensReady = false;

  constructor(options?: IVecEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
    this.loopConfig = options?.loopConfig;
    this.dataDir = options?.dataDir;
    if (options?.dataDir) {
      this.taskStateManager = new TaskStateManager(options.dataDir);
    }
  }

  async start(): Promise<void> {
    if (this.provider) {
      await this.provider.start();
      devLog(`Provider "${this.provider.name}" started`);
    } else {
      devWarn("No LLM provider configured — running in echo mode");
    }

    if (this.taskStateManager) {
      await this.taskStateManager.initialize();
      devLog("TaskStateManager initialized");
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
      this.recordTurnStatus(clientId, runHandle, "processing_started");
      const lastDigest = this.lastRunDigests.get(clientId);
      const system = await this.buildSystemContext(clientId, lastDigest);

      if (this.provider) {
        const toolDefs = this.toolExecutor?.definitions() ?? [];
        const workingMemory = new AgentWorkingMemory(runHandle.runId);
        const runWriter = this.createRunWriter(runHandle.runId, runHandle.sessionId, content);
        const contextTokenLimit = parseInt(process.env["CONTEXT_TOKEN_LIMIT"] ?? "", 10) || 100_000;
        const loop = new AgentLoop(
          this.provider,
          this.toolExecutor,
          this.sessionMemory,
          workingMemory,
          this.onReply,
          { ...this.loopConfig, contextTokenLimit },
          toolDefs,
          runWriter,
          this.taskStateManager,
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

        if (result.runDigest) {
          this.lastRunDigests.set(clientId, result.runDigest);
        }

        if (result.type === "reply") {
          // Check for active Tier 3 task — if subtasks remain, auto-continue silently
          const activeTask = this.taskStateManager?.getActiveTask(clientId);
          if (activeTask && activeTask.stage === "executing") {
            const nextSub = activeTask.subTasks.find((s) => s.status === "pending" || s.status === "in_progress");
            if (nextSub) {
              const continueMsg = `[Task: ${activeTask.taskId}] Continue task "${activeTask.goal}". Now working on subtask ${nextSub.id}: ${nextSub.title}. State: data/tasks/${activeTask.taskId}/state.json`;
              void this.processChat(clientId, continueMsg);
              return;
            }
          }
    
          this.sendAssistantReply(clientId, runHandle, result.content);
        } else if (result.type === "feedback") {
          this.recordTurnStatus(clientId, runHandle, "response_started");
          this.recordTurnStatus(clientId, runHandle, "response_completed");
          this.onReply?.(clientId, { type: "feedback_request", content: result.content });
        }
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

  private async buildSystemContext(clientId: string, lastRunDigest?: RunDigest): Promise<SystemContextBuildResult> {
    if (!this.staticContext) {
      return { systemContext: "", dynamicSystemTokens: 0 };
    }

    this.ensureStaticTokenCache();

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const promptInput = assemblePromptInput(this.staticContext, memoryContext);
    let systemContext = buildSystemPrompt({
      ...promptInput,
      includeToolDirectory: this.shouldIncludeToolDirectoryInPrompt(),
    }).systemPrompt;

    if (lastRunDigest) {
      systemContext += `\n\n${renderLastRunSection(lastRunDigest)}`;
    }

    const activeTask = this.taskStateManager?.getActiveTask(clientId);
    if (activeTask) {
      systemContext += `\n\n${renderTaskContextSection(activeTask)}`;
    }

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

  private async processToolCall(clientId: string, toolName: string, input: unknown): Promise<void> {
    try {
      const result = this.toolExecutor
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

    // Tool schemas are now selected dynamically per step and should be counted at runtime.
    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    this.sessionMemory.setStaticTokenBudget(this.staticSystemTokens);
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
  }

  private createRunWriter(
    runId: string,
    sessionId: string,
    userQuery: string,
  ): RunWorkingMemoryWriter | undefined {
    if (!this.dataDir) return undefined;
    try {
      return new RunWorkingMemoryWriter(runId, sessionId, userQuery, this.dataDir);
    } catch (err) {
      devWarn("Failed to create run working memory writer:", err instanceof Error ? err.message : String(err));
      return undefined;
    }
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
