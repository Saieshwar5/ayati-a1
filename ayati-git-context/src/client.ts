import { request as httpRequest, type RequestOptions } from "node:http";
import type {
  ActiveContext,
  AppendConversationRequest,
  AppendConversationResponse,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  GetActiveContextRequest,
  HealthResponse,
  StartRunRequest,
  StartRunResponse,
} from "./contracts.js";
import {
  GitContextServiceError,
  isGitContextErrorResponse,
} from "./errors.js";
import type { GitContextService } from "./service.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type GitContextClientConnection =
  | {
      socketPath: string;
    }
  | {
      host: string;
      port: number;
    };

export interface GitContextClientOptions {
  connection: GitContextClientConnection;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class GitContextClient implements GitContextService {
  private readonly connection: GitContextClientConnection;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GitContextClientOptions) {
    this.connection = options.connection;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer.");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes <= 0) {
      throw new Error("maxResponseBytes must be a positive integer.");
    }
  }

  async getHealth(): Promise<HealthResponse> {
    return await this.requestJson<HealthResponse>("GET", "/health");
  }

  async getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext> {
    const query = input.sessionId
      ? "?sessionId=" + encodeURIComponent(input.sessionId)
      : "";
    return await this.requestJson<ActiveContext>("GET", "/context/active" + query);
  }

  async ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse> {
    return await this.requestJson<EnsureActiveSessionResponse>(
      "POST",
      "/sessions/ensure-active",
      input,
    );
  }

  async appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse> {
    return await this.requestJson<AppendConversationResponse>(
      "POST",
      "/conversations/append",
      input,
    );
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.requestJson<StartRunResponse>("POST", "/runs/start", input);
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    input?: unknown,
  ): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const options: RequestOptions = {
      method,
      path,
      headers: {
        accept: "application/json",
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json; charset=utf-8",
              "content-length": Buffer.byteLength(body),
            }),
      },
      ...("socketPath" in this.connection
        ? { socketPath: this.connection.socketPath }
        : { host: this.connection.host, port: this.connection.port }),
    };

    return await new Promise<T>((resolve, reject) => {
      const request = httpRequest(options, (response) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > this.maxResponseBytes) {
            request.destroy(new Error("Git Context Engine response exceeded maximum size."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          try {
            const payload = parseResponseBody(Buffer.concat(chunks));
            if ((response.statusCode ?? 500) >= 400) {
              if (isGitContextErrorResponse(payload)) {
                reject(new GitContextServiceError(payload.error));
                return;
              }
              reject(new GitContextServiceError({
                code: "SERVICE_UNAVAILABLE",
                message: "Git Context Engine returned HTTP " + (response.statusCode ?? 500) + ".",
                retryable: true,
              }));
              return;
            }
            resolve(payload as T);
          } catch (error) {
            reject(error);
          }
        });
      });

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new GitContextServiceError({
          code: "SERVICE_UNAVAILABLE",
          message: "Git Context Engine request timed out.",
          retryable: true,
        }));
      });
      request.on("error", (error) => {
        reject(error instanceof GitContextServiceError
          ? error
          : new GitContextServiceError({
              code: "SERVICE_UNAVAILABLE",
              message: error.message,
              retryable: true,
            }));
      });
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  }
}

function parseResponseBody(buffer: Buffer): unknown {
  if (buffer.length === 0) {
    throw new GitContextServiceError({
      code: "SERVICE_UNAVAILABLE",
      message: "Git Context Engine returned an empty response.",
      retryable: true,
    });
  }
  try {
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new GitContextServiceError({
      code: "SERVICE_UNAVAILABLE",
      message: "Git Context Engine returned invalid JSON.",
      retryable: true,
    });
  }
}
