import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { StaticContext } from "../context/static-context-cache.js";
import { renderBasePromptSection } from "../prompt/sections/base.js";
import { renderSkillsSection } from "../prompt/sections/skills.js";
import { renderSoulSection } from "../prompt/sections/soul.js";
import { estimateTextTokens } from "../prompt/token-estimator.js";
import { devLog, devWarn, devError } from "../shared/index.js";
import {
  normalizeSystemEvent,
  type AyatiSystemEvent,
  type SystemEventClass,
  type SystemEventCreatedBy,
  type SystemEventEffectLevel,
  type SystemEventIntentKind,
  type SystemEventIntentMetadata,
  type SystemEventTrustTier,
} from "../core/contracts/plugin.js";
import type { ChatTurnRuntime } from "./chat-turn-runtime.js";
import type { SystemEventRuntime } from "./system-event-runtime.js";
import type {
  ChatAttachmentInput,
  ChatInboundMessage,
} from "./types.js";

interface StaticPromptSectionsCache {
  head: string;
  tail: string;
}

export interface IVecEngineOptions {
  provider?: LlmProvider;
  staticContext?: StaticContext;
  now?: () => Date;
  chatTurnRuntime?: ChatTurnRuntime;
  systemEventRuntime?: SystemEventRuntime;
}

export class IVecEngine {
  private readonly provider?: LlmProvider;
  private readonly staticContext?: StaticContext;
  private readonly nowProvider: () => Date;
  private readonly chatTurnRuntime?: ChatTurnRuntime;
  private readonly systemEventRuntime?: SystemEventRuntime;
  private staticSystemTokens = 0;
  private staticTokensReady = false;
  private staticPromptSections?: StaticPromptSectionsCache;

  constructor(options?: IVecEngineOptions) {
    this.provider = options?.provider;
    this.staticContext = options?.staticContext;
    this.nowProvider = options?.now ?? (() => new Date());
    this.chatTurnRuntime = options?.chatTurnRuntime;
    this.systemEventRuntime = options?.systemEventRuntime;
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
    await this.chatTurnRuntime?.drain();
    if (this.provider) {
      await this.provider.stop();
      devLog(`Provider "${this.provider.name}" stopped`);
    }
    devLog("IVecEngine stopped");
  }

  invalidateStaticTokenCache(): void {
    this.staticTokensReady = false;
    this.staticPromptSections = undefined;
  }

  handleMessage(clientId: string, data: unknown): void {
    devLog(`Message from ${clientId}:`, JSON.stringify(data));

    const payload = data as { type?: string };
    if (payload?.type === "system_event") {
      const systemEvent = this.toSystemEvent(data);
      if (!systemEvent) {
        devWarn("Ignored invalid system_event payload");
        return;
      }
      if (!this.systemEventRuntime) {
        devWarn("Ignored system_event because no system event runtime is configured.");
        return;
      }
      void this.systemEventRuntime.processSystemEvent({ clientId, event: systemEvent }).catch((err) => {
        devError("Unhandled system_event processing failure:", err);
      });
      return;
    }

    const msg = parseChatInboundMessage(data);
    if (!msg) return;

    if (!this.chatTurnRuntime) {
      devWarn("Ignored chat message because no chat turn runtime is configured.");
      return;
    }

    void this.chatTurnRuntime.processChat({
      clientId,
      content: msg.content,
      attachments: msg.attachments ?? [],
      uiContext: msg.uiContext,
    }).catch((err) => {
      devError("Unhandled chat processing failure:", err);
    });
  }

  async handleSystemEvent(clientId: string, event: AyatiSystemEvent): Promise<void> {
    if (!this.systemEventRuntime) {
      devWarn("Ignored system event because no system event runtime is configured.");
      return;
    }
    await this.systemEventRuntime.processSystemEvent({ clientId, event });
  }

  private toSystemEvent(data: unknown): AyatiSystemEvent | null {
    if (!data || typeof data !== "object") return null;
    const value = data as Record<string, unknown>;
    if (value["type"] !== "system_event") return null;
    const source = asRequiredString(value["source"]);
    const eventName = asRequiredString(value["eventName"]) ?? asRequiredString(value["event"]);
    if (!source || !eventName) {
      return null;
    }

    const eventId = asOptionalString(value["eventId"]) ?? randomUUID();
    const receivedAt = asOptionalString(value["receivedAt"])
      ?? asOptionalString(value["occurredAt"])
      ?? asOptionalString(value["triggeredAt"])
      ?? asOptionalString(value["scheduledFor"])
      ?? this.nowProvider().toISOString();
    const summary = this.toSystemEventSummary(source, eventName, value);
    if (!summary) {
      return null;
    }
    const payload = this.toSystemEventPayload(value);
    const intent = this.toSystemEventIntent(value);

    return normalizeSystemEvent({
      eventId,
      source,
      eventName,
      receivedAt,
      summary,
      payload,
      ...(intent ? { intent } : {}),
    });
  }

  private ensureStaticTokenCache(): void {
    if (this.staticTokensReady) return;
    if (!this.staticContext) {
      this.staticSystemTokens = 0;
      this.staticTokensReady = true;
      return;
    }

    const staticOnlyPrompt = this.buildStaticSystemContextText();

    const promptTokens = estimateTextTokens(staticOnlyPrompt);

    this.staticSystemTokens = promptTokens;
    this.staticTokensReady = true;
    devLog(`Static context tokens cached: ${this.staticSystemTokens} (prompt=${promptTokens})`);
  }

  private buildStaticSystemContextText(): string {
    const sections = this.getStaticPromptSections();
    return joinPromptSections([sections.head, sections.tail]);
  }

  private getStaticPromptSections(): StaticPromptSectionsCache {
    if (this.staticPromptSections) {
      return this.staticPromptSections;
    }

    if (!this.staticContext) {
      this.staticPromptSections = {
        head: "",
        tail: "",
      };
      return this.staticPromptSections;
    }

    const head = joinPromptSections([
      renderBasePromptSection(this.staticContext.basePrompt),
      renderSoulSection(this.staticContext.soul),
    ]);
    const tail = joinPromptSections([
      renderSkillsSection(this.staticContext.skillBlocks),
      renderToolDirectorySection(
        this.staticContext.toolDirectory,
        this.shouldIncludeToolDirectoryInPrompt(),
      ),
    ]);
    this.staticPromptSections = {
      head,
      tail,
    };
    return this.staticPromptSections;
  }

  private toSystemEventSummary(
    source: string,
    eventName: string,
    value: Record<string, unknown>,
  ): string | null {
    const summary = asOptionalString(value["summary"]);
    if (summary) {
      return summary;
    }

    const title = asOptionalString(value["title"]);
    const instruction = asOptionalString(value["instruction"]);
    if (source === "pulse" && eventName === "reminder_due") {
      return title
        ? `Reminder due: ${title}`
        : instruction
          ? `Reminder due: ${instruction}`
          : "Reminder due";
    }
    if (source === "pulse" && eventName === "task_due") {
      return title
        ? `Scheduled task due: ${title}`
        : instruction
          ? `Scheduled task due: ${instruction}`
          : "Scheduled task due";
    }

    const fallback = `${source} ${eventName}`.trim();
    return title ?? instruction ?? (fallback.length > 0 ? fallback : null);
  }

  private toSystemEventPayload(value: Record<string, unknown>): Record<string, unknown> {
    const directPayload = asRecord(value["payload"]);
    if (directPayload) {
      return directPayload;
    }

    const metadata = asRecord(value["metadata"]);
    const payload: Record<string, unknown> = {};
    const fieldMap = {
      occurrenceId: value["occurrenceId"],
      scheduledItemId: value["scheduledItemId"],
      reminderId: value["reminderId"],
      taskId: value["taskId"],
      title: value["title"],
      instruction: value["instruction"],
      scheduledFor: value["scheduledFor"],
      triggeredAt: value["triggeredAt"],
      timezone: value["timezone"],
      intentKind: value["intentKind"],
      requestedAction: value["requestedAction"],
      originRunId: value["originRunId"],
      originSessionId: value["originSessionId"],
    } satisfies Record<string, unknown>;

    for (const [key, fieldValue] of Object.entries(fieldMap)) {
      if (fieldValue !== undefined) {
        payload[key] = fieldValue;
      }
    }

    if (metadata) {
      payload["metadata"] = metadata;
    }

    return payload;
  }

  private toSystemEventIntent(value: Record<string, unknown>): SystemEventIntentMetadata | undefined {
    const nestedIntent = asRecord(value["intent"]);
    const kind = asSystemEventIntentKind(nestedIntent?.["kind"])
      ?? asSystemEventIntentKind(value["intentKind"]);
    const eventClass = asSystemEventClass(nestedIntent?.["eventClass"])
      ?? asSystemEventClass(value["eventClass"])
      ?? asSystemEventClass(value["event_class"]);
    const trustTier = asSystemEventTrustTier(nestedIntent?.["trustTier"])
      ?? asSystemEventTrustTier(value["trustTier"])
      ?? asSystemEventTrustTier(value["trust_tier"]);
    const effectLevel = asSystemEventEffectLevel(nestedIntent?.["effectLevel"])
      ?? asSystemEventEffectLevel(value["effectLevel"])
      ?? asSystemEventEffectLevel(value["effect_level"]);
    const requestedAction = asOptionalString(nestedIntent?.["requestedAction"])
      ?? asOptionalString(value["requestedAction"]);
    const createdBy = asSystemEventCreatedBy(nestedIntent?.["createdBy"])
      ?? asSystemEventCreatedBy(value["createdBy"]);

    if (!kind && !eventClass && !trustTier && !effectLevel && !requestedAction && !createdBy) {
      return undefined;
    }

    return {
      ...(kind ? { kind } : {}),
      ...(eventClass ? { eventClass } : {}),
      ...(trustTier ? { trustTier } : {}),
      ...(effectLevel ? { effectLevel } : {}),
      ...(requestedAction ? { requestedAction } : {}),
      ...(createdBy ? { createdBy } : {}),
    };
  }

  private shouldIncludeToolDirectoryInPrompt(): boolean {
    return process.env["PROMPT_INCLUDE_TOOL_DIRECTORY"] === "1";
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asOptionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter((entry) => entry.length > 0);
  return strings.length > 0 ? strings : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asSystemEventIntentKind(value: unknown): SystemEventIntentKind | undefined {
  return value === "reminder" || value === "task" || value === "notification" || value === "unknown"
    ? value
    : undefined;
}

function asSystemEventCreatedBy(value: unknown): SystemEventCreatedBy | undefined {
  return value === "user" || value === "agent" || value === "system" || value === "external" || value === "unknown"
    ? value
    : undefined;
}

function asSystemEventClass(value: unknown): SystemEventClass | undefined {
  return value === "message_received"
    || value === "trigger_fired"
    || value === "task_requested"
    || value === "state_changed"
    || value === "artifact_received"
    || value === "approval_response"
    ? value
    : undefined;
}

function asSystemEventTrustTier(value: unknown): SystemEventTrustTier | undefined {
  return value === "internal" || value === "trusted_system" || value === "external"
    ? value
    : undefined;
}

function asSystemEventEffectLevel(value: unknown): SystemEventEffectLevel | undefined {
  return value === "observe" || value === "assist" || value === "act" || value === "act_external"
    ? value
    : undefined;
}

export function parseChatInboundMessage(data: unknown): ChatInboundMessage | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as Record<string, unknown>;
  if (payload["type"] !== "chat") {
    return null;
  }

  const content = payload["content"];
  if (typeof content !== "string") {
    return null;
  }

  const uiContext = parseAgentUiContext(payload["uiContext"]);
  const attachmentsRaw = payload["attachments"];
  if (!Array.isArray(attachmentsRaw)) {
    return {
      type: "chat",
      content,
      ...(uiContext ? { uiContext } : {}),
    };
  }

  const attachments: ChatAttachmentInput[] = [];
  for (const row of attachmentsRaw) {
    const value = asRecord(row);
    if (!value) {
      continue;
    }

    const fileId = typeof value["fileId"] === "string" ? value["fileId"].trim() : "";
    if (fileId.length > 0) {
      attachments.push({
        source: "file",
        fileId,
      });
      continue;
    }

    const attachmentType = typeof value["type"] === "string" ? value["type"].trim().toLowerCase() : undefined;
    const source = typeof value["source"] === "string" ? value["source"].trim().toLowerCase() : undefined;
    if (attachmentType === "directory") {
      if (source !== undefined && source !== "cli") {
        continue;
      }
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (path.length === 0) {
        continue;
      }

      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      const include = asOptionalStringArray(value["include"]);
      const exclude = asOptionalStringArray(value["exclude"]);
      const maxDepth = asOptionalPositiveNumber(value["maxDepth"]);
      const maxFiles = asOptionalPositiveNumber(value["maxFiles"]);
      attachments.push({
        type: "directory",
        source: "cli",
        path,
        ...(name ? { name } : {}),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        ...(maxDepth !== undefined ? { maxDepth } : {}),
        ...(maxFiles !== undefined ? { maxFiles } : {}),
      });
      continue;
    }

    if (attachmentType !== "upload" && (source === undefined || source === "cli")) {
      const path = typeof value["path"] === "string" ? value["path"].trim() : "";
      if (path.length === 0) {
        continue;
      }

      const name = typeof value["name"] === "string" ? value["name"].trim() : undefined;
      attachments.push({
        ...(attachmentType === "file" ? { type: "file" as const } : {}),
        source: "cli",
        path,
        ...(name ? { name } : {}),
      });
      continue;
    }

    if (source !== "upload" && attachmentType !== "upload") {
      continue;
    }

    const uploadedPath = typeof value["uploadedPath"] === "string" ? value["uploadedPath"].trim() : "";
    const originalName = typeof value["originalName"] === "string" ? value["originalName"].trim() : "";
    if (uploadedPath.length === 0 || originalName.length === 0) {
      continue;
    }

    const mimeType = typeof value["mimeType"] === "string" ? value["mimeType"].trim() : undefined;
    const sizeBytes = asOptionalPositiveNumber(value["sizeBytes"]);
    attachments.push({
      source: "upload",
      uploadedPath,
      originalName,
      ...(mimeType ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }

  return {
    type: "chat",
    content,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(uiContext ? { uiContext } : {}),
  };
}

function parseAgentUiContext(raw: unknown): ChatInboundMessage["uiContext"] | undefined {
  const value = asRecord(raw);
  if (!value || value["source"] !== "agent-cli") {
    return undefined;
  }

  const processTreePids = Array.isArray(value["processTreePids"])
    ? value["processTreePids"].flatMap((entry) => (
      typeof entry === "number" && Number.isInteger(entry) && entry > 0 ? [entry] : []
    ))
    : undefined;
  const terminalPid = asOptionalPositiveInteger(value["terminalPid"]);
  const processPid = asOptionalPositiveInteger(value["processPid"]);
  const workspaceId = asOptionalPositiveInteger(value["workspaceId"]);
  const windowAddress = asOptionalString(value["windowAddress"]);
  const windowClass = asOptionalString(value["windowClass"]);
  const windowTitle = asOptionalString(value["windowTitle"]);
  const workspaceName = asOptionalString(value["workspaceName"]);
  const monitor = asOptionalString(value["monitor"]);
  const detectedAt = asOptionalString(value["detectedAt"]);

  if (!windowAddress && !workspaceName && !workspaceId && !terminalPid && !processPid) {
    return undefined;
  }

  return {
    source: "agent-cli",
    ...(terminalPid !== undefined ? { terminalPid } : {}),
    ...(processPid !== undefined ? { processPid } : {}),
    ...(processTreePids && processTreePids.length > 0 ? { processTreePids: [...new Set(processTreePids)] } : {}),
    ...(windowAddress ? { windowAddress } : {}),
    ...(windowClass ? { windowClass } : {}),
    ...(windowTitle ? { windowTitle } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(workspaceName ? { workspaceName } : {}),
    ...(monitor ? { monitor } : {}),
    ...(detectedAt ? { detectedAt } : {}),
  };
}

function joinPromptSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n\n").trim();
}

function renderToolDirectorySection(toolDirectory: string | undefined, includeToolDirectory: boolean): string {
  if (!includeToolDirectory) return "";
  if (!toolDirectory || toolDirectory.trim().length === 0) return "";
  return `# Available Tools\n\n${toolDirectory}`;
}

export { IVecEngine as AgentEngine };
export type AgentEngineOptions = IVecEngineOptions;
