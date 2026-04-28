import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { devError, devLog, devWarn } from "../shared/index.js";
import type { ToolDefinition, ToolResult } from "../skills/types.js";
import { persistManagedUpload, type ManagedUploadRecord } from "./upload-storage.js";
import type { FileLibrary } from "../files/file-library.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8081;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_ALLOW_ORIGIN = "*";
const UPLOAD_PATH = "/api/uploads";
const ARTIFACT_PATH_PREFIX = "/api/artifacts/";
const PULSE_PATH = "/api/pulse";

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

export interface UploadServerOptions {
  uploadsDir: string;
  runsDir?: string;
  host?: string;
  port?: number;
  maxUploadBytes?: number;
  maxJsonBytes?: number;
  allowOrigin?: string;
  pulseTool?: ToolDefinition;
  pulseClientId?: string;
  pulseApiToken?: string;
  fileLibrary?: FileLibrary;
}

type UploadBlobLike = {
  size: number;
  type?: string;
  name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export class UploadServer {
  readonly uploadsDir: string;
  readonly runsDir: string;
  private readonly host: string;
  private readonly port: number;
  private readonly maxUploadBytes: number;
  private readonly maxJsonBytes: number;
  private readonly allowOrigin: string;
  private readonly pulseTool: ToolDefinition | null;
  private readonly pulseClientId: string;
  private readonly pulseApiToken: string | null;
  private readonly fileLibrary?: FileLibrary;
  private server: Server | null = null;

  constructor(options: UploadServerOptions) {
    this.uploadsDir = resolve(options.uploadsDir);
    this.runsDir = resolve(options.runsDir ?? join(this.uploadsDir, "..", "..", "runs"));
    this.host = options.host?.trim() || DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.maxUploadBytes = Math.max(1024, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    this.maxJsonBytes = Math.max(1024, options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES);
    this.allowOrigin = options.allowOrigin?.trim() || DEFAULT_ALLOW_ORIGIN;
    this.pulseTool = options.pulseTool ?? null;
    this.pulseClientId = options.pulseClientId?.trim() || "local";
    this.pulseApiToken = options.pulseApiToken?.trim() || null;
    this.fileLibrary = options.fileLibrary;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolveStart, rejectStart) => {
      this.server?.once("error", rejectStart);
      this.server?.listen(this.port, this.host, () => {
        this.server?.off("error", rejectStart);
        resolveStart();
      });
    });

    devLog(`HTTP API server listening on http://${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolveStop) => {
      this.server?.close(() => resolveStop());
    });
    this.server = null;
    devLog("HTTP API server stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(res);

    if (req.method === "OPTIONS" && isManagedPath(req.url ?? "/")) {
      res.statusCode = 204;
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `${this.host}:${this.port}`}`);
    if (requestUrl.pathname === PULSE_PATH) {
      await this.handlePulseRequest(req, res);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname.startsWith(ARTIFACT_PATH_PREFIX)) {
      try {
        await this.handleArtifactDownload(res, requestUrl.pathname);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = classifyArtifactError(message);
        if (statusCode >= 500) {
          devError("Artifact server error:", message);
        } else {
          devWarn(`Artifact request rejected: ${message}`);
        }
        this.sendJson(res, statusCode, { error: message });
      }
      return;
    }

    if (req.method !== "POST" || requestUrl.pathname !== UPLOAD_PATH) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    try {
      const uploaded = await this.handleUpload(req, requestUrl);
      this.sendJson(res, 201, uploaded);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = classifyUploadError(message);
      if (statusCode >= 500) {
        devError("Upload server error:", message);
      } else {
        devWarn(`Upload rejected: ${message}`);
      }
      this.sendJson(res, statusCode, { error: message });
    }
  }

  private async handleUpload(req: IncomingMessage, requestUrl: URL): Promise<ManagedUploadRecord> {
    const contentType = req.headers["content-type"]?.trim() ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new Error("unsupported content type: expected multipart/form-data.");
    }

    const contentLength = parseOptionalPositiveIntHeader(req.headers["content-length"]);
    if (contentLength !== undefined && contentLength > this.maxUploadBytes) {
      throw new Error(`upload exceeds ${this.maxUploadBytes} bytes.`);
    }

    const rawBody = await readRequestBody(req, this.maxUploadBytes, "upload");
    const request = new Request(requestUrl, {
      method: "POST",
      headers: toHeaders(req.headers),
      body: rawBody,
    });
    const formData = await request.formData();
    const file = formData.get("file");
    if (!isUploadBlobLike(file)) {
      throw new Error("missing multipart file field 'file'.");
    }

    const originalName = file.name?.trim() || "";
    if (originalName.length === 0) {
      throw new Error("uploaded file is missing a filename.");
    }

    if (file.size > this.maxUploadBytes) {
      throw new Error(`upload exceeds ${this.maxUploadBytes} bytes.`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (this.fileLibrary) {
      const managed = await this.fileLibrary.registerUpload({
        originalName,
        mimeType: file.type?.trim() || undefined,
        bytes,
        origin: "user_upload",
      });
      return {
        uploadId: managed.fileId,
        fileId: managed.fileId,
        uploadedPath: managed.storagePath,
        originalName: managed.originalName,
        ...(managed.mimeType ? { mimeType: managed.mimeType } : {}),
        sizeBytes: managed.sizeBytes,
      };
    }

    return persistManagedUpload({
      uploadsDir: this.uploadsDir,
      originalName,
      mimeType: file.type?.trim() || undefined,
      bytes,
      maxUploadBytes: this.maxUploadBytes,
    });
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", this.allowOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  }

  private async handlePulseRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.pulseTool) {
      this.sendJson(res, 503, { ok: false, error: "pulse API is not configured." });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(res, 405, { ok: false, error: "method not allowed: use POST." });
      return;
    }

    const auth = this.authorizePulseRequest(req);
    if (!auth.ok) {
      this.sendJson(res, auth.statusCode, { ok: false, error: auth.error });
      return;
    }

    const contentType = req.headers["content-type"]?.trim() ?? "";
    if (!isJsonContentType(contentType)) {
      this.sendJson(res, 415, { ok: false, error: "unsupported content type: expected application/json." });
      return;
    }

    try {
      const rawBody = await readRequestBody(req, this.maxJsonBytes, "request");
      const input = parseJsonBody(rawBody);
      const result = await this.pulseTool.execute(input, { clientId: this.pulseClientId });
      this.sendPulseResult(res, input, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = classifyPulseException(message);
      if (statusCode >= 500) {
        devError("Pulse API server error:", message);
      } else {
        devWarn(`Pulse API request rejected: ${message}`);
      }
      this.sendJson(res, statusCode, { ok: false, error: message });
    }
  }

  private authorizePulseRequest(req: IncomingMessage): { ok: true } | { ok: false; statusCode: number; error: string } {
    if (this.pulseApiToken) {
      const token = readBearerToken(req.headers["authorization"]);
      if (!token) {
        return { ok: false, statusCode: 401, error: "missing bearer token." };
      }
      if (token !== this.pulseApiToken) {
        return { ok: false, statusCode: 403, error: "invalid bearer token." };
      }
      return { ok: true };
    }

    if (isLoopbackAddress(req.socket.remoteAddress)) {
      return { ok: true };
    }

    return { ok: false, statusCode: 403, error: "pulse API requires a bearer token for non-local requests." };
  }

  private sendPulseResult(res: ServerResponse, input: unknown, result: ToolResult): void {
    if (!result.ok) {
      const error = result.error ?? "Pulse command failed.";
      this.sendJson(res, classifyPulseToolError(error), { ok: false, error, meta: result.meta });
      return;
    }

    this.sendJson(res, pulseSuccessStatusCode(input), {
      ok: true,
      data: parseJsonOutput(result.output),
      meta: result.meta,
    });
  }

  private async handleArtifactDownload(res: ServerResponse, pathname: string): Promise<void> {
    const suffix = pathname.slice(ARTIFACT_PATH_PREFIX.length);
    const segments = suffix.split("/").filter((segment) => segment.length > 0).map((segment) => decodeURIComponent(segment));
    const [runId, ...artifactSegments] = segments;
    if (!runId || artifactSegments.length === 0) {
      throw new Error("artifact path is incomplete.");
    }

    const artifactRelativePath = artifactSegments.join(sep);
    const runRoot = resolve(this.runsDir, runId);
    const filePath = resolve(runRoot, artifactRelativePath);
    const allowedPrefix = `${runRoot}${sep}`;
    if (filePath !== runRoot && !filePath.startsWith(allowedPrefix)) {
      throw new Error("artifact path escapes the run directory.");
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("artifact file was not found.");
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", getContentType(filePath));
    res.setHeader("Content-Length", String(fileStat.size));
    res.setHeader("Cache-Control", "public, max-age=3600");

    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(filePath);
      stream.on("error", rejectStream);
      stream.on("end", resolveStream);
      res.on("error", rejectStream);
      stream.pipe(res);
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  }
}

function toHeaders(headers: IncomingMessage["headers"]): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized.set(key, value.join(", "));
      continue;
    }
    if (typeof value === "string") {
      normalized.set(key, value);
    }
  }
  return normalized;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number, label = "request"): Promise<Buffer> {
  return await new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        rejectBody(new Error(`${label} exceeds ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });

    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
    req.on("aborted", () => rejectBody(new Error("upload request was aborted.")));
  });
}

function parseOptionalPositiveIntHeader(value: string | string[] | undefined): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return undefined;
  }

  const parsed = Number.parseInt(first, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function isUploadBlobLike(value: unknown): value is UploadBlobLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate["arrayBuffer"] === "function"
    && typeof candidate["size"] === "number";
}

function classifyUploadError(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("exceeds")) return 413;
  if (normalized.includes("unsupported")) return 415;
  if (normalized.includes("missing") || normalized.includes("empty")) return 400;
  return 500;
}

function classifyArtifactError(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("incomplete") || normalized.includes("escapes")) return 400;
  if (normalized.includes("not found")) return 404;
  return 500;
}

function isManagedPath(url: string): boolean {
  return url.startsWith(UPLOAD_PATH) || url.startsWith(ARTIFACT_PATH_PREFIX) || url.startsWith(PULSE_PATH);
}

function getContentType(filePath: string): string {
  const lowerPath = filePath.toLowerCase();
  const extension = lowerPath.slice(lowerPath.lastIndexOf("."));
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}

function isJsonContentType(value: string): boolean {
  const normalized = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized === "application/json" || normalized.endsWith("+json");
}

function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) {
    throw new Error("request body is empty.");
  }

  try {
    return JSON.parse(rawBody.toString("utf-8")) as unknown;
  } catch {
    throw new Error("request body must be valid JSON.");
  }
}

function parseJsonOutput(output: string | undefined): unknown {
  if (!output) {
    return null;
  }

  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function pulseSuccessStatusCode(input: unknown): number {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const action = (input as Record<string, unknown>)["action"];
    return action === "create" ? 201 : 200;
  }
  return 200;
}

function classifyPulseToolError(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("not found")) return 404;
  if (
    normalized.includes("invalid input")
    || normalized.includes("requires")
    || normalized.includes("must")
    || normalized.includes("unable to parse")
    || normalized.includes("unsupported")
  ) {
    return 400;
  }
  return 500;
}

function classifyPulseException(message: string): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("exceeds")) return 413;
  if (normalized.includes("empty") || normalized.includes("valid json")) return 400;
  return 500;
}

function readBearerToken(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return null;
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "::1"
    || value === "127.0.0.1"
    || value.startsWith("127.")
    || value.startsWith("::ffff:127.");
}
