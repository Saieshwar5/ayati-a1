import { devLog } from "../shared/index.js";

export interface AgentEngineOptions {
  onReply?: (clientId: string, data: unknown) => void;
}

export class AgentEngine {
  private readonly onReply?: (clientId: string, data: unknown) => void;

  constructor(options?: AgentEngineOptions) {
    this.onReply = options?.onReply;
  }

  async start(): Promise<void> {
    devLog("AgentEngine started");
  }

  async stop(): Promise<void> {
    devLog("AgentEngine stopped");
  }

  handleMessage(clientId: string, data: unknown): void {
    devLog(`Message from ${clientId}:`, JSON.stringify(data));

    const msg = data as { type?: string; content?: string };
    if (msg.type === "chat" && typeof msg.content === "string") {
      this.onReply?.(clientId, {
        type: "reply",
        content: `Received: "${msg.content}"`,
      });
    }
  }
}
