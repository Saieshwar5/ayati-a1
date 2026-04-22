import type { PluginSystemEventInput } from "../../core/contracts/plugin.js";
import type {
  CanonicalInboundEvent,
  ExternalSystemRequest,
  SourceManifest,
  SystemAdapter,
} from "../../core/contracts/system-ingress.js";
import { parseAgentMailWebhook } from "./helpers.js";

export interface AgentMailAdapterOptions {
  allowedSenders: string[];
}

export class AgentMailAdapter implements SystemAdapter {
  private readonly allowedSenders: string[];

  constructor(options: AgentMailAdapterOptions) {
    this.allowedSenders = options.allowedSenders.map((value) => value.toLowerCase());
  }

  manifest(): SourceManifest {
    return {
      sourceId: "agentmail",
      displayName: "AgentMail",
      sourceType: "external",
      transport: "webhook",
      authMode: "custom",
      defaultEnabled: true,
      defaultPolicyMode: "analyze_ask",
      supportsRawPersistence: true,
    };
  }

  canHandle(input: ExternalSystemRequest): boolean {
    return input.source === "agentmail";
  }

  normalize(input: ExternalSystemRequest): readonly (PluginSystemEventInput | CanonicalInboundEvent)[] {
    const rawBody = input.body ?? JSON.stringify(input.payload ?? {});
    const parsed = parseAgentMailWebhook(input.payload, rawBody);
    if (!parsed || parsed.eventType !== "message.received") {
      return [];
    }

    if (this.allowedSenders.length > 0) {
      const sender = parsed.senderEmail?.toLowerCase();
      if (!sender || !this.allowedSenders.includes(sender)) {
        return [];
      }
    }

    return [parsed.systemEvent];
  }

  dedupeKey(event: CanonicalInboundEvent): string {
    return `agentmail:${event.eventId}`;
  }
}
