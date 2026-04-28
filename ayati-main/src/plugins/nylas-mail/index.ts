import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";
import type { AyatiPlugin, PluginRuntimeContext } from "../../core/contracts/plugin.js";
import { devError, devLog, devWarn } from "../../shared/index.js";
import { NylasMailAdapter } from "./adapter.js";
import {
  extractGrantProfile,
  normalizeWebhookPath,
  verifyNylasSignature,
  type NormalizedGrantProfile,
} from "./helpers.js";

const DEFAULT_API_URI = "https://api.us.nylas.com";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_250_000;

interface NylasMailPluginConfig {
  enabled: boolean;
  apiKey?: string;
  grantId?: string;
  apiUri: string;
  host: string;
  port: number;
  webhookPath: string;
  listenerPath: string;
  webhookPublicUrl?: string;
  webhookSecret?: string;
  verifySignature: boolean;
  description: string;
  maxPayloadBytes: number;
}

interface PersistedWebhookSecret {
  webhookId?: string;
  webhookSecret: string;
  updatedAt: string;
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

function loadConfig(overrides: Partial<NylasMailPluginConfig> = {}): NylasMailPluginConfig {
  const explicitEnabled = process.env["NYLAS_MAIL_PLUGIN_ENABLED"];
  const apiKey = process.env["NYLAS_API_KEY"]?.trim() || undefined;
  const grantId = process.env["NYLAS_GRANT_ID"]?.trim() || undefined;
  const webhookPublicUrl = process.env["NYLAS_WEBHOOK_PUBLIC_URL"]?.trim() || undefined;
  const webhookSecret = process.env["NYLAS_WEBHOOK_SECRET"]?.trim() || undefined;
  const inferredEnabled = Boolean(apiKey || grantId || webhookPublicUrl || webhookSecret);
  const webhookPath = normalizeWebhookPath(process.env["NYLAS_WEBHOOK_PATH"]);

  const baseConfig: NylasMailPluginConfig = {
    enabled: explicitEnabled !== undefined ? isTruthyEnv(explicitEnabled, false) : inferredEnabled,
    apiKey,
    grantId,
    apiUri: (process.env["NYLAS_API_URI"]?.trim() || DEFAULT_API_URI).replace(/\/+$/, ""),
    host: process.env["NYLAS_WEBHOOK_HOST"]?.trim() || DEFAULT_HOST,
    port: parsePositiveInt(process.env["NYLAS_WEBHOOK_PORT"], DEFAULT_PORT),
    webhookPath,
    listenerPath: webhookPath,
    webhookPublicUrl,
    webhookSecret,
    verifySignature: isTruthyEnv(process.env["NYLAS_WEBHOOK_VERIFY_SIGNATURE"], true),
    description: process.env["NYLAS_WEBHOOK_DESCRIPTION"]?.trim() || "ayati-nylas-mail",
    maxPayloadBytes: parsePositiveInt(process.env["NYLAS_WEBHOOK_MAX_PAYLOAD_BYTES"], DEFAULT_MAX_PAYLOAD_BYTES),
  };

  return {
    ...baseConfig,
    ...overrides,
    webhookPath: normalizeWebhookPath(overrides.webhookPath ?? baseConfig.webhookPath),
    listenerPath: normalizeWebhookPath(overrides.listenerPath ?? overrides.webhookPath ?? baseConfig.listenerPath),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObjectArray(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is Record<string, unknown> => isObject(item));
  }
  if (isObject(payload) && Array.isArray(payload["data"])) {
    return payload["data"].filter((item): item is Record<string, unknown> => isObject(item));
  }
  if (isObject(payload) && Array.isArray(payload["webhooks"])) {
    return payload["webhooks"].filter((item): item is Record<string, unknown> => isObject(item));
  }
  return [];
}

function extractWebhookRecord(payload: unknown): Record<string, unknown> | null {
  if (isObject(payload) && isObject(payload["data"])) {
    return payload["data"];
  }
  return isObject(payload) ? payload : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readWebhookId(webhook: Record<string, unknown>): string | undefined {
  return asString(webhook["id"]) ?? asString(webhook["webhook_id"]) ?? asString(webhook["webhookId"]);
}

function readWebhookUrl(webhook: Record<string, unknown>): string | undefined {
  return asString(webhook["webhook_url"]) ?? asString(webhook["webhookUrl"]) ?? asString(webhook["url"]);
}

function readWebhookSecret(payload: unknown): string | undefined {
  const record = extractWebhookRecord(payload);
  return asString(record?.["webhook_secret"]) ?? asString(record?.["webhookSecret"]);
}

function readWebhookTriggers(webhook: Record<string, unknown>): string[] {
  const raw = webhook["trigger_types"] ?? webhook["triggerTypes"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => (typeof item === "string" && item.trim().length > 0 ? [item.trim()] : []));
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

export class NylasMailPlugin implements AyatiPlugin {
  readonly name = "nylas-mail";
  readonly version = "1.0.0";

  private readonly config: NylasMailPluginConfig;
  private readonly adapter: NylasMailAdapter;
  private server: Server | null = null;
  private runtimeContext: PluginRuntimeContext | null = null;
  private grantProfile: NormalizedGrantProfile = {};
  private webhookSecret: string | undefined;
  private webhookSecretPath: string | null = null;

  constructor(overrides: Partial<NylasMailPluginConfig> = {}) {
    this.config = loadConfig(overrides);
    this.webhookSecret = this.config.webhookSecret;
    this.adapter = new NylasMailAdapter({
      grantId: this.config.grantId,
      getGrantProfile: () => this.grantProfile,
      fetchMessage: async (grantId, messageId) => await this.fetchMessage(grantId, messageId),
    });
  }

  async start(context: PluginRuntimeContext): Promise<void> {
    this.runtimeContext = context;
    this.webhookSecretPath = resolve(context.dataDir, "nylas-mail", "webhook-secret.json");
    context.registerSystemAdapter?.(this.adapter);

    if (!this.config.enabled) {
      devLog("Nylas Mail plugin disabled via NYLAS_MAIL_PLUGIN_ENABLED.");
      return;
    }

    if (!this.webhookSecret) {
      await this.loadPersistedSecret().catch((err) => {
        devWarn(`Failed to load persisted Nylas webhook secret: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    await this.refreshGrantProfile().catch((err) => {
      devWarn(`Nylas grant profile lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    await this.startListener();
    await this.bootstrap().catch((err) => {
      devError("Nylas Mail bootstrap failed:", err instanceof Error ? err.message : String(err));
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
    devLog("Nylas Mail webhook listener stopped.");
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
      `Nylas Mail webhook listener running on http://${this.config.host}:${this.config.port}${this.config.listenerPath}`,
    );
  }

  private async bootstrap(): Promise<void> {
    if (!this.config.apiKey || !this.config.grantId) {
      devWarn("Nylas Mail plugin started without NYLAS_API_KEY or NYLAS_GRANT_ID. Auto-registration is disabled.");
      return;
    }

    if (!this.config.webhookPublicUrl) {
      devWarn("NYLAS_WEBHOOK_PUBLIC_URL is missing. Nylas webhook registration was skipped.");
      return;
    }

    try {
      const publicPath = new URL(this.config.webhookPublicUrl).pathname;
      if (publicPath !== this.config.listenerPath) {
        devWarn(
          `Nylas webhook public path (${publicPath}) does not match local listener path (${this.config.listenerPath}).`,
        );
      }
    } catch {
      devWarn("NYLAS_WEBHOOK_PUBLIC_URL is not a valid URL. Nylas webhook registration was skipped.");
      return;
    }

    await this.ensureWebhook();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === this.config.listenerPath) {
      const challenge = url.searchParams.get("challenge");
      if (challenge) {
        const challengeBuffer = Buffer.from(challenge, "utf-8");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Length", String(challengeBuffer.length));
        res.end(challengeBuffer);
        return;
      }

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

    let rawBody = "";
    try {
      rawBody = await readJsonRequestBody(req, this.config.maxPayloadBytes);
    } catch (err) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    if (this.config.verifySignature) {
      const currentSecret = this.webhookSecret;
      if (!currentSecret) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json");
        res.end(json({ ok: false, error: "Webhook secret is not configured." }));
        return;
      }

      const signature = req.headers["x-nylas-signature"];
      const providedSignature = Array.isArray(signature) ? signature[0] : signature;
      if (!verifyNylasSignature(currentSecret, rawBody, providedSignature)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(json({ ok: false, error: "Invalid webhook signature." }));
        return;
      }
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

    try {
      if (!this.runtimeContext?.ingestExternalRequest) {
        throw new Error("Plugin runtime does not support external ingress.");
      }

      const result = await this.runtimeContext.ingestExternalRequest({
        source: "nylas-mail",
        clientId: this.runtimeContext.clientId,
        method: req.method ?? "POST",
        path: url.pathname,
        headers: req.headers,
        body: rawBody,
        payload,
        metadata: {
          listenerPath: this.config.listenerPath,
        },
      });

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(json({
        ok: true,
        accepted: result.accepted,
        queued: result.queuedCount,
        duplicates: result.duplicateCount,
        reason: result.reason ?? null,
      }));
    } catch (err) {
      devError("Failed to ingest Nylas webhook:", err instanceof Error ? err.message : String(err));
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(json({ ok: false, error: "Failed to ingest webhook request." }));
    }
  }

  private async refreshGrantProfile(): Promise<void> {
    if (!this.config.apiKey || !this.config.grantId) {
      return;
    }

    const payload = await this.requestJson(`/v3/grants/${encodeURIComponent(this.config.grantId)}`);
    this.grantProfile = extractGrantProfile(payload);
    if (this.grantProfile.email || this.grantProfile.provider) {
      devLog(
        `Nylas grant profile ready${this.grantProfile.email ? ` for ${this.grantProfile.email}` : ""}${this.grantProfile.provider ? ` provider=${this.grantProfile.provider}` : ""}`,
      );
    }
  }

  private async ensureWebhook(): Promise<void> {
    const webhookUrl = this.config.webhookPublicUrl;
    if (!webhookUrl) {
      return;
    }

    const webhooks = await this.listWebhooks();
    const existing = webhooks.find((webhook) => readWebhookUrl(webhook) === webhookUrl);
    if (existing) {
      const triggers = readWebhookTriggers(existing);
      if (!triggers.includes("message.created")) {
        devWarn(
          `Existing Nylas webhook ${readWebhookId(existing) ?? "(unknown)"} does not subscribe to message.created; auto-registration skipped.`,
        );
        return;
      }

      if (!this.webhookSecret) {
        const webhookId = readWebhookId(existing);
        if (webhookId) {
          await this.rotateWebhookSecret(webhookId);
        }
      }
      devLog(`Nylas webhook already configured${readWebhookId(existing) ? `: ${readWebhookId(existing)}` : ""}`);
      return;
    }

    const createdPayload = await this.requestJson("/v3/webhooks", {
      method: "POST",
      body: json({
        trigger_types: ["message.created"],
        description: this.config.description,
        webhook_url: webhookUrl,
      }),
    });
    const created = extractWebhookRecord(createdPayload);
    const webhookId = readWebhookId(created ?? {});
    const webhookSecret = readWebhookSecret(createdPayload);
    if (webhookSecret) {
      await this.persistWebhookSecret(webhookSecret, webhookId);
    } else {
      devWarn("Nylas webhook was created without a webhook_secret in the response.");
    }

    devLog(`Nylas webhook ready${webhookId ? `: ${webhookId}` : ""}`);
  }

  private async rotateWebhookSecret(webhookId: string): Promise<void> {
    const payload = await this.requestJson(`/v3/webhooks/rotate-secret/${encodeURIComponent(webhookId)}`, {
      method: "POST",
    });
    const webhookSecret = readWebhookSecret(payload);
    if (!webhookSecret) {
      devWarn(`Nylas rotate-secret response for ${webhookId} did not include webhook_secret.`);
      return;
    }
    await this.persistWebhookSecret(webhookSecret, webhookId);
    devLog(`Nylas webhook secret rotated for ${webhookId}.`);
  }

  private async listWebhooks(): Promise<Record<string, unknown>[]> {
    const payload = await this.requestJson("/v3/webhooks");
    return asObjectArray(payload);
  }

  private async fetchMessage(grantId: string, messageId: string): Promise<Record<string, unknown> | null> {
    if (!this.config.apiKey) {
      return null;
    }

    const payload = await this.requestJson(
      `/v3/grants/${encodeURIComponent(grantId)}/messages/${encodeURIComponent(messageId)}`,
    );
    const data = isObject(payload) && isObject(payload["data"]) ? payload["data"] : payload;
    return isObject(data) ? data : null;
  }

  private async requestJson(path: string, init?: RequestInit): Promise<unknown> {
    if (!this.config.apiKey) {
      throw new Error("NYLAS_API_KEY is not configured.");
    }

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    headers.set("Accept", "application/json");
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${this.config.apiUri}${path}`, {
      ...init,
      headers,
    });
    const text = await response.text();
    const parsed = text.length > 0 ? this.tryParseJson(text) : null;

    if (!response.ok) {
      throw new Error(`Nylas API ${response.status} ${path}: ${text.slice(0, 400)}`);
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

  private async loadPersistedSecret(): Promise<void> {
    if (!this.webhookSecretPath) {
      return;
    }

    try {
      const payload = JSON.parse(await readFile(this.webhookSecretPath, "utf-8")) as PersistedWebhookSecret;
      if (typeof payload.webhookSecret === "string" && payload.webhookSecret.trim().length > 0) {
        this.webhookSecret = payload.webhookSecret.trim();
      }
    } catch {
      // Ignore missing or unreadable persisted secret files.
    }
  }

  private async persistWebhookSecret(webhookSecret: string, webhookId?: string): Promise<void> {
    this.webhookSecret = webhookSecret;
    if (!this.webhookSecretPath) {
      return;
    }

    await mkdir(dirname(this.webhookSecretPath), { recursive: true });
    await writeFile(this.webhookSecretPath, JSON.stringify({
      ...(webhookId ? { webhookId } : {}),
      webhookSecret,
      updatedAt: new Date().toISOString(),
    } satisfies PersistedWebhookSecret, null, 2));
  }
}

const plugin: AyatiPlugin = new NylasMailPlugin();

export default plugin;
