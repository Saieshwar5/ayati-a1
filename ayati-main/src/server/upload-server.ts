import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { devError, devLog, devWarn } from "../shared/index.js";
import { persistManagedUpload, type ManagedUploadRecord } from "./upload-storage.js";
import type { FileLibrary } from "../files/file-library.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8081;
const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_ALLOW_ORIGIN = "*";
const UPLOAD_PATH = "/api/uploads";

export interface UploadServerOptions {
  uploadsDir: string;
  host?: string;
  port?: number;
  maxUploadBytes?: number;
  allowOrigin?: string;
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
  private readonly host: string;
  private readonly port: number;
  private readonly maxUploadBytes: number;
  private readonly allowOrigin: string;
  private readonly fileLibrary?: FileLibrary;
  private server: Server | null = null;

  constructor(options: UploadServerOptions) {
    this.uploadsDir = resolve(options.uploadsDir);
    this.host = options.host?.trim() || DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.maxUploadBytes = Math.max(1024, options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
    this.allowOrigin = options.allowOrigin?.trim() || DEFAULT_ALLOW_ORIGIN;
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

function isManagedPath(url: string): boolean {
  return url.startsWith(UPLOAD_PATH);
}
