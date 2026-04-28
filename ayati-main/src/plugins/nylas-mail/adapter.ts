import type { PluginSystemEventInput } from "../../core/contracts/plugin.js";
import type {
  CanonicalInboundEvent,
  ExternalSystemRequest,
  SourceManifest,
  SystemAdapter,
} from "../../core/contracts/system-ingress.js";
import {
  buildSystemEventFromNylasNotification,
  type NormalizedGrantProfile,
  parseNylasWebhookNotifications,
} from "./helpers.js";

export interface NylasMailAdapterOptions {
  grantId?: string;
  getGrantProfile?: () => NormalizedGrantProfile | undefined;
  fetchMessage?: (grantId: string, messageId: string) => Promise<Record<string, unknown> | null>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export class NylasMailAdapter implements SystemAdapter {
  private readonly grantId?: string;
  private readonly getGrantProfile?: () => NormalizedGrantProfile | undefined;
  private readonly fetchMessage?: (grantId: string, messageId: string) => Promise<Record<string, unknown> | null>;

  constructor(options: NylasMailAdapterOptions) {
    this.grantId = options.grantId?.trim() || undefined;
    this.getGrantProfile = options.getGrantProfile;
    this.fetchMessage = options.fetchMessage;
  }

  manifest(): SourceManifest {
    return {
      sourceId: "nylas-mail",
      displayName: "Nylas Mail",
      sourceType: "external",
      transport: "webhook",
      authMode: "signature",
      defaultEnabled: true,
      defaultPolicyMode: "analyze_ask",
      supportsRawPersistence: true,
    };
  }

  canHandle(input: ExternalSystemRequest): boolean {
    return input.source === "nylas-mail";
  }

  async normalize(input: ExternalSystemRequest): Promise<readonly (PluginSystemEventInput | CanonicalInboundEvent)[]> {
    const rawBody = input.body ?? JSON.stringify(input.payload ?? {});
    const notifications = parseNylasWebhookNotifications(input.payload, rawBody);
    const normalized: PluginSystemEventInput[] = [];

    for (const notification of notifications) {
      if (!notification.eventName.startsWith("message.created")) {
        continue;
      }

      if (this.grantId && notification.grantId && notification.grantId !== this.grantId) {
        continue;
      }

      let message = notification.message;
      const effectiveGrantId = notification.grantId ?? this.grantId;
      const shouldHydrate = notification.truncated
        || notification.metadataOnly
        || notification.transformed
        || !message;

      if (shouldHydrate && this.fetchMessage && effectiveGrantId && notification.messageId) {
        try {
          const hydrated = await this.fetchMessage(effectiveGrantId, notification.messageId);
          if (hydrated) {
            message = hydrated;
          }
        } catch {
          // Let the raw webhook payload drive the event if hydration fails.
        }
      }

      const systemEvent = buildSystemEventFromNylasNotification(
        notification,
        message,
        this.getGrantProfile?.(),
      );
      if (!systemEvent) {
        continue;
      }

      if (this.grantId) {
        const payloadGrantId = asNonEmptyString(systemEvent.payload["grantId"]);
        if (payloadGrantId && payloadGrantId !== this.grantId) {
          continue;
        }
      }

      normalized.push(systemEvent);
    }

    return normalized;
  }

  dedupeKey(event: CanonicalInboundEvent): string {
    const messageId = asNonEmptyString(event.payload["messageId"]);
    if (messageId) {
      return `nylas-mail:message:${messageId}`;
    }
    return `nylas-mail:${event.eventId}`;
  }
}
