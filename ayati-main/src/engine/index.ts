import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
} from "../core/contracts/llm-protocol.js";
import { noopSessionMemory } from "../memory/provider.js";
import type {
  SessionMemory,
  MemoryRunHandle,
} from "../memory/types.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { assemblePromptInput } from "../context/load-system-prompt-input.js";
import { buildSystemPrompt } from "../prompt/builder.js";
import type { ToolExecutor } from "../skills/tool-executor.js";
import type { ToolResult } from "../skills/types.js";
import { devLog, devWarn, devError } from "../shared/index.js";

const MAX_TOOL_STEPS = 6;

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
  if (!executor) return [];
  return executor
    .definitions()
    .filter((tool) => !!tool.inputSchema)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    }));
}

export interface AgentEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
  provider?: LlmProvider;
  staticContext?: StaticContext;
  sessionMemory?: SessionMemory;
  toolExecutor?: ToolExecutor;
}

export class AgentEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly toolExecutor?: ToolExecutor;
  private readonly sessionMemory: SessionMemory;

  constructor(options?: AgentEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.toolExecutor = options?.toolExecutor;
    this.sessionMemory = options?.sessionMemory ?? noopSessionMemory;
  }

  async start(): Promise<void> {
    if (this.provider) {
      await this.provider.start();
      devLog(`Provider "${this.provider.name}" started`);
    } else {
      devWarn("No LLM provider configured — running in echo mode");
    }
    devLog("AgentEngine started");
  }

  async stop(): Promise<void> {
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("AgentEngine stopped");
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
      const systemContext = this.buildSystemContext();

      if (this.provider) {
        const reply = await this.runAutonomousLoop(clientId, content, systemContext, runHandle);
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

  private buildSystemContext(): string {
    if (!this.staticContext) return "";

    const memoryContext = this.sessionMemory.getPromptMemoryContext();
    const promptInput = assemblePromptInput(this.staticContext, memoryContext);
    return buildSystemPrompt(promptInput).systemPrompt;
  }

  private async runAutonomousLoop(
    clientId: string,
    userContent: string,
    systemContext: string,
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
      const turn = await this.provider.generateTurn({
        messages,
        ...(hasTools ? { tools } : {}),
      });

      if (turn.type === "assistant") {
        return turn.content;
      }

      if (!this.toolExecutor) {
        return "I cannot execute tools in the current runtime configuration.";
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
        const result = await this.executeSingleToolCall(clientId, step, call, runHandle);
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
    try {
      result = await this.toolExecutor!.execute(call.name, call.input, { clientId });
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : "Unknown tool execution error",
      };
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
    if (!this.toolExecutor) {
      this.onReply?.(clientId, {
        type: "tool_result",
        name: toolName,
        result: {
          ok: false,
          error: "Tool execution is not configured.",
        },
      });
      return;
    }

    try {
      const result = await this.toolExecutor.execute(toolName, input, { clientId });
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
}
