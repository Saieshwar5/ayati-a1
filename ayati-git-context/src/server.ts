import { lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  isAcquireMutationAuthorityRequest,
  isAppendConversationRequest,
  isCheckpointMutationRequest,
  isCreateTaskRequest,
  isEnsureActiveSessionRequest,
  isMountTaskRequest,
  isRecordRunStepRequest,
  isSnapshotTaskRunEvidenceRequest,
  isStartRunRequest,
  isVerifyMutationRequest,
} from "./contracts.js";
import {
  GitContextServiceError,
  type GitContextErrorCode,
  type GitContextErrorResponse,
} from "./errors.js";
import type { GitContextService } from "./service.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type GitContextServerListenOptions =
  | {
      socketPath: string;
    }
  | {
      host: string;
      port: number;
    };

export interface GitContextHttpServerOptions {
  service: GitContextService;
  listen: GitContextServerListenOptions;
  maxBodyBytes?: number;
}

export type GitContextServerAddress =
  | {
      kind: "unix";
      socketPath: string;
    }
  | {
      kind: "tcp";
      host: string;
      port: number;
    };

export class GitContextHttpServer {
  private readonly service: GitContextService;
  private readonly listenOptions: GitContextServerListenOptions;
  private readonly maxBodyBytes: number;
  private server: Server | undefined;
  private address: GitContextServerAddress | undefined;

  constructor(options: GitContextHttpServerOptions) {
    this.service = options.service;
    this.listenOptions = options.listen;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) {
      throw new Error("maxBodyBytes must be a positive integer.");
    }
  }

  async start(): Promise<GitContextServerAddress> {
    if (this.server) {
      throw new Error("Git Context Engine HTTP server is already started.");
    }

    if ("socketPath" in this.listenOptions) {
      await removeStaleSocket(this.listenOptions.socketPath);
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;

    try {
      await listen(server, this.listenOptions);
      this.address = resolveServerAddress(server, this.listenOptions);
      return this.address;
    } catch (error) {
      this.server = undefined;
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    this.address = undefined;
    await close(server);
    if ("socketPath" in this.listenOptions) {
      await removeSocketIfPresent(this.listenOptions.socketPath);
    }
  }

  getAddress(): GitContextServerAddress | undefined {
    return this.address;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, await this.service.getHealth());
        return;
      }

      if (method === "GET" && url.pathname === "/context/active") {
        const sessionId = url.searchParams.get("sessionId")?.trim();
        sendJson(response, 200, await this.service.getActiveContext({
          ...(sessionId ? { sessionId } : {}),
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/sessions/ensure-active") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isEnsureActiveSessionRequest(body)) {
          throw invalidRequest("Invalid ensure-active session request.");
        }
        sendJson(response, 200, await this.service.ensureActiveSession(body));
        return;
      }

      if (method === "POST" && url.pathname === "/conversations/append") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isAppendConversationRequest(body)) {
          throw invalidRequest("Invalid append-conversation request.");
        }
        sendJson(response, 200, await this.service.appendConversation(body));
        return;
      }

      if (method === "POST" && url.pathname === "/tasks") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isCreateTaskRequest(body)) {
          throw invalidRequest("Invalid create-task request.");
        }
        sendJson(response, 200, await this.service.createTask(body));
        return;
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch) {
        const taskId = decodePathComponent(taskMatch[1] ?? "");
        sendJson(response, 200, await this.service.getTask({ taskId }));
        return;
      }

      const mountMatch = url.pathname.match(
        /^\/sessions\/([^/]+)\/tasks\/([^/]+)\/mount$/,
      );
      if (method === "POST" && mountMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isMountTaskRequest(body)) {
          throw invalidRequest("Invalid mount-task request.");
        }
        const sessionId = decodePathComponent(mountMatch[1] ?? "");
        const taskId = decodePathComponent(mountMatch[2] ?? "");
        if (body.sessionId !== sessionId || body.taskId !== taskId) {
          throw invalidRequest("Session and task IDs in request path and body must match.");
        }
        sendJson(response, 200, await this.service.mountTask(body));
        return;
      }

      const mutationAuthorityMatch = url.pathname.match(
        /^\/runs\/([^/]+)\/tasks\/([^/]+)\/mutation-authority$/,
      );
      if (method === "POST" && mutationAuthorityMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isAcquireMutationAuthorityRequest(body)) {
          throw invalidRequest("Invalid mutation-authority request.");
        }
        const runId = decodePathComponent(mutationAuthorityMatch[1] ?? "");
        const taskId = decodePathComponent(mutationAuthorityMatch[2] ?? "");
        if (body.runId !== runId || body.taskId !== taskId) {
          throw invalidRequest("Run and task IDs in request path and body must match.");
        }
        sendJson(response, 200, await this.service.acquireMutationAuthority(body));
        return;
      }

      const verifyMutationMatch = url.pathname.match(
        /^\/mutation-authorities\/([^/]+)\/verify$/,
      );
      if (method === "POST" && verifyMutationMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isVerifyMutationRequest(body)) {
          throw invalidRequest("Invalid verify-mutation request.");
        }
        const authorityId = decodePathComponent(verifyMutationMatch[1] ?? "");
        if (body.authorityId !== authorityId) {
          throw invalidRequest("Authority ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.verifyMutation(body));
        return;
      }

      const checkpointMutationMatch = url.pathname.match(
        /^\/mutation-authorities\/([^/]+)\/checkpoint$/,
      );
      if (method === "POST" && checkpointMutationMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isCheckpointMutationRequest(body)) {
          throw invalidRequest("Invalid checkpoint-mutation request.");
        }
        const authorityId = decodePathComponent(checkpointMutationMatch[1] ?? "");
        if (body.authorityId !== authorityId) {
          throw invalidRequest("Authority ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.checkpointMutation(body));
        return;
      }

      if (method === "POST" && url.pathname === "/runs/start") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isStartRunRequest(body)) {
          throw invalidRequest("Invalid start-run request.");
        }
        sendJson(response, 200, await this.service.startRun(body));
        return;
      }

      const runStepMatch = url.pathname.match(/^\/runs\/([^/]+)\/steps$/);
      if (method === "POST" && runStepMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isRecordRunStepRequest(body)) {
          throw invalidRequest("Invalid record-run-step request.");
        }
        const pathRunId = decodePathComponent(runStepMatch[1] ?? "");
        if (pathRunId !== body.runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.recordRunStep(body));
        return;
      }

      const runEvidenceMatch = url.pathname.match(/^\/runs\/([^/]+)\/evidence\/snapshot$/);
      if (method === "POST" && runEvidenceMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isSnapshotTaskRunEvidenceRequest(body)) {
          throw invalidRequest("Invalid task-run evidence snapshot request.");
        }
        const runId = decodePathComponent(runEvidenceMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.snapshotTaskRunEvidence(body));
        return;
      }

      const knownPath = isKnownPath(url.pathname)
        || Boolean(runStepMatch)
        || Boolean(taskMatch)
        || Boolean(mountMatch)
        || Boolean(mutationAuthorityMatch)
        || Boolean(verifyMutationMatch)
        || Boolean(checkpointMutationMatch)
        || Boolean(runEvidenceMatch);
      throw new GitContextServiceError({
        code: knownPath ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
        message: knownPath
          ? "Method " + method + " is not allowed for " + url.pathname + "."
          : "Route not found: " + url.pathname + ".",
      });
    } catch (error) {
      sendServiceError(response, error);
    }
  }
}

function isKnownPath(pathname: string): boolean {
  return pathname === "/health"
    || pathname === "/context/active"
    || pathname === "/sessions/ensure-active"
    || pathname === "/conversations/append"
    || pathname === "/tasks"
    || pathname === "/runs/start";
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }

  if (tooLarge) {
    throw new GitContextServiceError({
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds " + maxBodyBytes + " bytes.",
    });
  }

  if (chunks.length === 0) {
    throw invalidRequest("Request body is required.");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw invalidRequest("Request body must be valid JSON.");
  }
}

function invalidRequest(message: string): GitContextServiceError {
  return new GitContextServiceError({
    code: "INVALID_REQUEST",
    message,
  });
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidRequest("Request path contains invalid percent encoding.");
  }
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent) {
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendServiceError(response: ServerResponse, error: unknown): void {
  const serviceError = error instanceof GitContextServiceError
    ? error
    : new GitContextServiceError({
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unexpected Git Context Engine error.",
      });
  sendJson(response, errorStatusCode(serviceError.code), serviceError.toResponse());
}

function errorStatusCode(code: GitContextErrorCode): number {
  switch (code) {
    case "INVALID_REQUEST":
      return 400;
    case "NOT_FOUND":
    case "TASK_NOT_FOUND":
      return 404;
    case "METHOD_NOT_ALLOWED":
      return 405;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "SESSION_HEAD_MISMATCH":
    case "IDEMPOTENCY_CONFLICT":
    case "RUN_ALREADY_ACTIVE":
    case "TASK_LOCKED":
    case "TASK_CHECKOUT_DIRTY":
    case "TASK_HEAD_MISMATCH":
    case "RUN_ALREADY_FINALIZED":
    case "GIT_CONFLICT":
      return 409;
    case "SERVICE_NOT_READY":
    case "SERVICE_UNAVAILABLE":
    case "REPOSITORY_UNAVAILABLE":
    case "RECOVERY_REQUIRED":
      return 503;
    default:
      return 422;
  }
}

function listen(server: Server, options: GitContextServerListenOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if ("socketPath" in options) {
      server.listen(options.socketPath);
    } else {
      server.listen(options.port, options.host);
    }
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function resolveServerAddress(
  server: Server,
  options: GitContextServerListenOptions,
): GitContextServerAddress {
  if ("socketPath" in options) {
    return { kind: "unix", socketPath: options.socketPath };
  }
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Git Context Engine server did not expose a TCP address.");
  }
  return {
    kind: "tcp",
    host: address.address,
    port: address.port,
  };
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error("Refusing to replace non-socket path: " + socketPath);
    }
    await rm(socketPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

async function removeSocketIfPresent(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (stat.isSocket()) {
      await rm(socketPath);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

export type { GitContextErrorResponse };
