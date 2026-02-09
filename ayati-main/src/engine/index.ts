import type { LlmProvider } from "../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
} from "../core/contracts/llm-protocol.js";
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
  context?: string;
  toolExecutor?: ToolExecutor;
}

export class AgentEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;
  private readonly provider?: LlmProvider;
  private readonly context: string;
  private readonly toolExecutor?: ToolExecutor;

  constructor(options?: AgentEngineOptions) {
    this.onReply = options?.onReply;
    this.provider = options?.provider;
    this.context = options?.context ?? "";
    this.toolExecutor = options?.toolExecutor;
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
    try {
      if (this.provider) {
        const reply = await this.runAutonomousLoop(clientId, content);
        this.onReply?.(clientId, { type: "reply", content: reply });
      } else {
        this.onReply?.(clientId, {
          type: "reply",
          content: `Received: "${content}"`,
        });
      }
    } catch (err) {
      devError("Provider error:", err);
      this.onReply?.(clientId, {
        type: "error",
        content: "Failed to generate a response.",
      });
    }
  }

  private async runAutonomousLoop(clientId: string, userContent: string): Promise<string> {
    if (!this.provider) return `Received: "${userContent}"`;

    const messages: LlmMessage[] = [];
    if (this.context.trim().length > 0) {
      messages.push({ role: "system", content: this.context });
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
        const result = await this.executeSingleToolCall(clientId, step, call);
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
  ): Promise<ToolResult> {
    const result = await this.toolExecutor!.execute(call.name, call.input, { clientId });
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
