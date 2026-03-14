import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";
import type { AyatiPlugin, PluginRuntimeContext, PluginSystemEventInput } from "../../core/contracts/plugin.js";
import { devError, devLog, devWarn } from "../../shared/index.js";
import {
  buildWebhookListenerPath,
  normalizeWebhookPath,
  parseAgentMailWebhook,
  parseAllowedSenders,
  sanitizeEventIdForFileName,
} from "./helpers.js";

const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_PAYLOAD_BYTES = 512_000;

interface AgentMailPluginConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  host: string;
  port: number;
  webhookPath: string;
  listenerPath: string;
  webhookToken?: string;
  webhookPublicUrl?: string;
  inboxId?: string;
  inboxUsername: string;
  inboxDomain: string;
  inboxDisplayName: string;
  inboxClientId: string;
  webhookClientId: string;
  allowedSenders: string[];
  maxPayloadBytes: number;
}

interface AgentMailInbox {
  inbox_id?: string;
  display_name?: string;
}

interface AgentMailWebhook {
  webhook_id?: string;
  client_id?: string;
  url?: string;
  event_types?: string[];
  inbox_ids?: string[];
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isTruthyEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (!rawValue) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(normalized)) return false;
  if (["1", "true", "on", "yes"].includes(normalized)) return true;
  return fallback;
}

function loadConfig(): AgentMailPluginConfig {
  const inboxId = process.env["AGENTMAIL_INBOX_ID"]?.trim() || undefined;
  const explicitEnabled = process.env["AGENTMAIL_PLUGIN_ENABLED"];
  const apiKey = process.env["AGENTMAIL_API_KEY"]?.trim() || undefined;
  const webhookPublicUrl = process.env["AGENTMAIL_WEBHOOK_PUBLIC_URL"]?.trim() || undefined;
  const [defaultUsername, defaultDomain] = inboxId?.split("@") ?? [];
  const webhookPath = normalizeWebhookPath(process.env["AGENTMAIL_WEBHOOK_PATH"]);
  const webhookToken = process.env["AGENTMAIL_WEBHOOK_TOKEN"]?.trim() || undefined;
  const inferredEnabled = Boolean(apiKey || webhookPublicUrl || inboxId || webhookToken);

  return {
    enabled: explicitEnabled !== undefined ? isTruthyEnv(explicitEnabled, false) : inferredEnabled,
    apiKey,
    baseUrl: (process.env["AGENTMAIL_BASE_URL"]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    host: process.env["AGENTMAIL_WEBHOOK_HOST"]?.trim() || DEFAULT_HOST,
    port: parsePositiveInt(process.env["AGENTMAIL_WEBHOOK_PORT"], DEFAULT_PORT),
    webhookPath,
    listenerPath: buildWebhookListenerPath(webhookPath, webhookToken),
    webhookToken,
    webhookPublicUrl,
    inboxId,
    inboxUsername: process.env["AGENTMAIL_INBOX_USERNAME"]?.trim() || defaultUsername || "ayati",
    inboxDomain: process.env["AGENTMAIL_INBOX_DOMAIN"]?.trim() || defaultDomain || "agentmail.to",
    inboxDisplayName: process.env["AGENTMAIL_INBOX_DISPLAY_NAME"]?.trim() || "Ayati",
    inboxClientId: process.env["AGENTMAIL_INBOX_CLIENT_ID"]?.trim() || "ayati-main-inbox",
    webhookClientId: process.env["AGENTMAIL_WEBHOOK_CLIENT_ID"]?.trim() || "ayati-agentmail-webhook",
    allowedSenders: parseAllowedSenders(process.env["AGENTMAIL_ALLOWED_SENDERS"]),
    maxPayloadBytes: parsePositiveInt(process.env["AGENTMAIL_WEBHOOK_MAX_PAYLOAD_BYTES"], DEFAULT_MAX_PAYLOAD_BYTES),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInboxArray(payload: unknown): AgentMailInbox[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is AgentMailInbox => isObject(item));
  }
  if (isObject(payload) && Array.isArray(payload["inboxes"])) {
    return payload["inboxes"].filter((item): item is AgentMailInbox => isObject(item));
  }
  return [];
}

function asWebhookArray(payload: unknown): AgentMailWebhook[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is AgentMailWebhook => isObject(item));
  }
  if (isObject(payload) && Array.isArray(payload["webhooks"])) {
    return payload["webhooks"].filter((item): item is AgentMailWebhook => isObject(item));
  }
  return [];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function readJsonRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        rejectBody(new Error(`Webhook payload exceeded ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf-8"));
    });

    req.on("error", rejectBody);
    req.on("aborted", () => rejectBody(new Error("Webhook request was aborted.")));
  });
}

class AgentMailPlugin implements AyatiPlugin {
  readonly name = "agentmail";
  readonly version = "1.0.0";

  private readonly config = loadConfig();
  private server: Server | null = null;
  private runtimeContext: PluginRuntimeContext | null = null;

  async start(context: PluginRuntimeContext): Promise<void> {
    this.runtimeContext = context;

    if (!this.config.enabled) {
      devLog("AgentMail plugin disabled via AGENTMAIL_PLUGIN_ENABLED.");
      return;
    }

    await this.startListener();
    await this.bootstrap().catch((err) => {
      devError("AgentMail bootstrap failed:", err instanceof Error ? err.message : String(err));
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolveStop) => {
      this.server?.close(() => resolveStop());
    });
    this.server = null;
    devLog("AgentMail webhook listener stopped.");
  }

  private async startListener(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      this.server?.once("error", rejectStart);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off("error", rejectStart);
        resolveStart();
      });
    });

    devLog(
      `AgentMail webhook listener running on http://${this.config.host}:${this.config.port}${this.config.listenerPath}`,
    );
  }

  private async bootstrap(): Promise<void> {
    if (!this.config.apiKey) {
      devWarn("AgentMail plugin started without AGENTMAIL_API_KEY. Auto-registration is disabled.");
      return;
    }

    const resolvedInboxId = await this.ensureInbox();

    if (!this.config.webhookPublicUrl) {
      devWarn("AGENTMAIL_WEBHOOK_PUBLIC_URL is missing. AgentMail webhook registration was skipped.");
      return;
    }

    try {
      const publicPath = new URL(this.config.webhookPublicUrl).pathname;
      if (publicPath !== this.config.listenerPath) {
        devWarn(
          `AgentMail public webhook path (${publicPath}) does not match local listener path (${this.config.listenerPath}).`,
        );
      }
    } catch {
      devWarn("AGENTMAIL_WEBHOOK_PUBLIC_URL is not a valid URL. AgentMail webhook registration was skipped.");
      return;
    }

    await this.ensureWebhook(resolvedInboxId);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === this.config.listenerPath) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: true, plugin: this.name, listenerPath: this.config.listenerPath }));
      return;
    }

    if (req.method !== "POST" || url.pathname !== this.config.listenerPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    devLog(`AgentMail webhook received: method=${req.method} path=${url.pathname}`);

    let rawBody = "";
    try {
      rawBody = await readJsonRequestBody(req, this.config.maxPayloadBytes);
    } catch (err) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    let payload: unknown;
    try {
      payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
    } catch {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: false, error: "Invalid JSON payload." }));
      return;
    }

    const parsed = parseAgentMailWebhook(payload, rawBody);
    if (!parsed) {
      devWarn("AgentMail webhook ignored: unsupported payload shape.");
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: true, accepted: false, reason: "Unsupported payload." }));
      return;
    }

    devLog(
      `AgentMail webhook parsed: event=${parsed.eventType} eventId=${parsed.eventId} sender=${parsed.senderEmail ?? "unknown"}`,
    );

    if (parsed.eventType !== "message.received") {
      devLog(`AgentMail webhook ignored: unsupported event ${parsed.eventType}.`);
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: true, accepted: false, reason: `Ignoring event ${parsed.eventType}.` }));
      return;
    }

    if (this.config.allowedSenders.length > 0) {
      const sender = parsed.senderEmail?.toLowerCase();
      if (!sender || !this.config.allowedSenders.includes(sender)) {
        devWarn(`AgentMail webhook blocked sender: ${sender ?? "unknown"}`);
        res.statusCode = 202;
        res.setHeader("Content-Type", "application/json");
        res.end(json({ ok: true, accepted: false, reason: "Sender not allowlisted." }));
        return;
      }
    }

    const saved = await this.persistEvent(parsed.eventId, rawBody).catch((err) => {
      devError("Failed to persist AgentMail event:", err instanceof Error ? err.message : String(err));
      return null;
    });
    if (saved === null) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: false, error: "Failed to persist incoming event." }));
      return;
    }
    if (!saved) {
      devLog(`AgentMail webhook ignored duplicate event: ${parsed.eventId}`);
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: true, accepted: false, reason: "Duplicate event." }));
      return;
    }

    devLog(`AgentMail webhook accepted: eventId=${parsed.eventId}`);
    res.statusCode = 202;
    res.setHeader("Content-Type", "application/json");
    res.end(json({ ok: true, accepted: true, eventId: parsed.eventId }));

    void this.dispatchIncomingEvent(parsed.systemEvent);
  }

  private async dispatchIncomingEvent(event: PluginSystemEventInput): Promise<void> {
    try {
      if (!this.runtimeContext) {
        throw new Error("Plugin runtime context is not available.");
      }
      devLog(
        `AgentMail publish start: source=${event.source} eventName=${event.eventName} eventId=${event.eventId ?? "generated"} summary=${event.summary}`,
      );
      await this.runtimeContext.publishSystemEvent(event);
      devLog(`AgentMail publish success: eventId=${event.eventId ?? "generated"}`);
    } catch (err) {
      devError("Failed to dispatch AgentMail system event:", err instanceof Error ? err.message : String(err));
    }
  }

  private async persistEvent(eventId: string, rawBody: string): Promise<boolean> {
    if (!this.runtimeContext) {
      throw new Error("Plugin runtime context is not available.");
    }

    const safeEventId = sanitizeEventIdForFileName(eventId);
    const eventPath = resolve(this.runtimeContext.dataDir, "agentmail", "events", `${safeEventId}.json`);
    await mkdir(dirname(eventPath), { recursive: true });

    try {
      await writeFile(eventPath, rawBody, { encoding: "utf-8", flag: "wx" });
      return true;
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  private async ensureInbox(): Promise<string> {
    if (this.config.inboxId) {
      return this.config.inboxId;
    }

    const targetInboxId = `${this.config.inboxUsername}@${this.config.inboxDomain}`;
    const inboxesPayload = await this.requestJson("/inboxes?limit=100");
    const existingInbox = asInboxArray(inboxesPayload).find((inbox) => inbox.inbox_id === targetInboxId);
    if (existingInbox?.inbox_id) {
      devLog(`AgentMail inbox found: ${existingInbox.inbox_id}`);
      return existingInbox.inbox_id;
    }

    const createdPayload = await this.requestJson("/inboxes", {
      method: "POST",
      body: json({
        username: this.config.inboxUsername,
        domain: this.config.inboxDomain,
        display_name: this.config.inboxDisplayName,
        client_id: this.config.inboxClientId,
      }),
    });

    const created = isObject(createdPayload) ? createdPayload : {};
    const createdInboxId = typeof created["inbox_id"] === "string" ? created["inbox_id"] : undefined;
    if (!createdInboxId) {
      throw new Error("AgentMail inbox creation succeeded without returning inbox_id.");
    }

    devLog(`AgentMail inbox ready: ${createdInboxId}`);
    return createdInboxId;
  }

  private async ensureWebhook(inboxId: string): Promise<void> {
    const webhookUrl = this.config.webhookPublicUrl;
    if (!webhookUrl) {
      return;
    }

    const webhooksPayload = await this.requestJson("/webhooks");
    const webhooks = asWebhookArray(webhooksPayload);
    const existingWebhook = webhooks.find((webhook) => {
      const eventTypes = Array.isArray(webhook.event_types) ? webhook.event_types : [];
      const inboxIds = Array.isArray(webhook.inbox_ids) ? webhook.inbox_ids : [];
      return webhook.url === webhookUrl
        && webhook.client_id === this.config.webhookClientId
        && eventTypes.includes("message.received")
        && (inboxIds.length === 0 || inboxIds.includes(inboxId));
    });

    if (existingWebhook?.webhook_id) {
      devLog(`AgentMail webhook already configured: ${existingWebhook.webhook_id}`);
      return;
    }

    const staleWebhook = webhooks.find((webhook) => {
      const eventTypes = Array.isArray(webhook.event_types) ? webhook.event_types : [];
      return webhook.url === webhookUrl
        && webhook.client_id === this.config.webhookClientId
        && eventTypes.includes("message.received");
    });

    if (staleWebhook?.webhook_id) {
      devWarn(
        `AgentMail webhook ${staleWebhook.webhook_id} is bound to the wrong inbox; recreating for ${inboxId}.`,
      );
      await this.requestJson(`/webhooks/${staleWebhook.webhook_id}`, {
        method: "DELETE",
      });
    }

    const createdPayload = await this.requestJson("/webhooks", {
      method: "POST",
      body: json({
        url: webhookUrl,
        event_types: ["message.received"],
        inbox_ids: [inboxId],
        client_id: this.config.webhookClientId,
      }),
    });

    const created = isObject(createdPayload) ? createdPayload : {};
    const webhookId = typeof created["webhook_id"] === "string" ? created["webhook_id"] : undefined;
    devLog(`AgentMail webhook ready${webhookId ? `: ${webhookId}` : ""}`);
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    if (!this.config.apiKey) {
      throw new Error("AGENTMAIL_API_KEY is not configured.");
    }

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    const parsed = text.length > 0 ? this.tryParseJson(text) : null;

    if (!response.ok) {
      throw new Error(`AgentMail API ${response.status} ${path}: ${text.slice(0, 400)}`);
    }

    return parsed ?? {};
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text };
    }
  }
}

const plugin: AyatiPlugin = new AgentMailPlugin();

export default plugin;
