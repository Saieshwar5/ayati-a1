import { lstat, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  isAcquireMutationAuthorityRequest,
  isActivateTaskRunRequest,
  isAdoptTaskReferenceRequest,
  isAppendConversationRequest,
  isBindTaskAttachmentsRequest,
  isCompleteContextTurnRequest,
  isCreateTaskRunRequest,
  isEnsureActiveSessionRequest,
  isFinalizeSessionRunRequest,
  isFinalizeTaskRunRequest,
  isPlanTaskRequestRouteRequest,
  isPrepareContextTurnRequest,
  isRecordRunStepRequest,
  isRecordSessionAttachmentsRequest,
  isStartRunRequest,
  isVerifyMutationRequest,
} from "./contracts.js";
import {
  GitContextServiceError,
  type GitContextErrorCode,
  type GitContextErrorResponse,
} from "./errors.js";
import type { GitContextService } from "./service.js";
import {
  GitContextObserver,
  runWithGitContextTrace,
} from "./observability.js";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

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
  observer?: GitContextObserver;
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
  private readonly observer: GitContextObserver;
  private server: Server | undefined;
  private address: GitContextServerAddress | undefined;

  constructor(options: GitContextHttpServerOptions) {
    this.service = options.service;
    this.listenOptions = options.listen;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.observer = options.observer ?? new GitContextObserver("git-context-http");
    if (!Number.isInteger(this.maxBodyBytes) || this.maxBodyBytes <= 0) {
      throw new Error("maxBodyBytes must be a positive integer.");
    }
  }

  async start(): Promise<GitContextServerAddress> {
    if (this.server) {
      throw new Error("Git Context Engine HTTP server is already started.");
    }

    if ("socketPath" in this.listenOptions) {
      await mkdir(dirname(this.listenOptions.socketPath), { recursive: true });
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
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";
    const traceId = request.headers["x-ayati-trace-id"]?.toString().trim() || randomUUID();
    const correlation = requestCorrelation(request);
    const operation = requestOperation(method, url.pathname);
    const startedAt = Date.now();
    let failed = false;
    this.observer.emit({
      level: "debug",
      event: "http_request_started",
      traceId,
      ...correlation,
      outcome: "started",
      data: {
        method,
        path: url.pathname,
        operation,
        requestBytes: Number(request.headers["content-length"] ?? 0),
      },
    });
    await runWithGitContextTrace(traceId, async () => {
      try {

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

      if (method === "POST" && url.pathname === "/context/turns/prepare") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isPrepareContextTurnRequest(body)) {
          throw invalidRequest("Invalid prepare-context-turn request.");
        }
        sendJson(response, 200, await this.service.prepareContextTurn(body));
        return;
      }

      if (method === "POST" && url.pathname === "/context/turns/complete") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isCompleteContextTurnRequest(body)) {
          throw invalidRequest("Invalid complete-context-turn request.");
        }
        sendJson(response, 200, await this.service.completeContextTurn(body));
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

      const sessionAttachmentsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/attachments$/);
      if (method === "POST" && sessionAttachmentsMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isRecordSessionAttachmentsRequest(body)) {
          throw invalidRequest("Invalid record-session-attachments request.");
        }
        const sessionId = decodePathComponent(sessionAttachmentsMatch[1] ?? "");
        if (body.sessionId !== sessionId) {
          throw invalidRequest("Session ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.recordSessionAttachments(body));
        return;
      }

      if (method === "GET" && url.pathname === "/tasks") {
        const query = url.searchParams.get("query")?.trim();
        const limitText = url.searchParams.get("limit")?.trim();
        const limit = limitText ? Number(limitText) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
          throw invalidRequest("Task list limit must be between 1 and 100.");
        }
        sendJson(response, 200, await this.service.listTasks({
          ...(query ? { query } : {}),
          ...(limit ? { limit } : {}),
        }));
        return;
      }

      if (method === "POST" && url.pathname === "/task-runs/create") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isCreateTaskRunRequest(body)) {
          throw invalidRequest("Invalid create-task-run request.");
        }
        sendJson(response, 200, await this.service.createTaskRun(body));
        return;
      }

      if (method === "POST" && url.pathname === "/task-runs/activate") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isActivateTaskRunRequest(body)) {
          throw invalidRequest("Invalid activate-task-run request.");
        }
        sendJson(response, 200, await this.service.activateTaskRun(body));
        return;
      }

      const requestRouteMatch = url.pathname.match(/^\/runs\/([^/]+)\/task-request-route$/);
      if (method === "POST" && requestRouteMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isPlanTaskRequestRouteRequest(body)) {
          throw invalidRequest("Invalid task-request-route request.");
        }
        const runId = decodePathComponent(requestRouteMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.planTaskRequestRoute(body));
        return;
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch) {
        const taskId = decodePathComponent(taskMatch[1] ?? "");
        sendJson(response, 200, await this.service.getTask({ taskId }));
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

      const adoptReferenceMatch = url.pathname.match(
        /^\/mutation-authorities\/([^/]+)\/adopt-reference$/,
      );
      if (method === "POST" && adoptReferenceMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isAdoptTaskReferenceRequest(body)) {
          throw invalidRequest("Invalid adopt-task-reference request.");
        }
        const authorityId = decodePathComponent(adoptReferenceMatch[1] ?? "");
        if (body.authorityId !== authorityId) {
          throw invalidRequest("Authority ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.adoptTaskReference(body));
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

      const taskAttachmentsMatch = url.pathname.match(/^\/runs\/([^/]+)\/task-attachments$/);
      if (method === "POST" && taskAttachmentsMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isBindTaskAttachmentsRequest(body)) {
          throw invalidRequest("Invalid bind-task-attachments request.");
        }
        const runId = decodePathComponent(taskAttachmentsMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.bindTaskAttachments(body));
        return;
      }

      const finalizeTaskRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/finalize-task$/);
      if (method === "POST" && finalizeTaskRunMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isFinalizeTaskRunRequest(body)) {
          throw invalidRequest("Invalid task-run finalization request.");
        }
        const runId = decodePathComponent(finalizeTaskRunMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.finalizeTaskRun(body));
        return;
      }

      const finalizeSessionRunMatch = url.pathname.match(
        /^\/runs\/([^/]+)\/finalize-session$/,
      );
      if (method === "POST" && finalizeSessionRunMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isFinalizeSessionRunRequest(body)) {
          throw invalidRequest("Invalid session-run finalization request.");
        }
        const runId = decodePathComponent(finalizeSessionRunMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.finalizeSessionRun(body));
        return;
      }

      const knownPath = isKnownPath(url.pathname)
        || Boolean(runStepMatch)
        || Boolean(taskMatch)
        || Boolean(mutationAuthorityMatch)
        || Boolean(verifyMutationMatch)
        || Boolean(sessionAttachmentsMatch)
        || Boolean(taskAttachmentsMatch)
        || Boolean(adoptReferenceMatch)
        || Boolean(finalizeTaskRunMatch)
        || Boolean(finalizeSessionRunMatch);
      throw new GitContextServiceError({
        code: knownPath ? "METHOD_NOT_ALLOWED" : "NOT_FOUND",
        message: knownPath
          ? "Method " + method + " is not allowed for " + url.pathname + "."
          : "Route not found: " + url.pathname + ".",
      });
      } catch (error) {
        failed = true;
        const serviceError = normalizeServiceError(error);
        this.observer.emit({
          level: serviceError.code === "INTERNAL_ERROR" ? "error" : "warn",
          event: "http_request_failed",
          traceId,
          ...correlation,
          durationMs: Date.now() - startedAt,
          outcome: "failed",
          errorCode: serviceError.code,
          message: serviceError.message,
          data: { method, path: url.pathname, operation },
        });
        sendServiceError(response, serviceError);
      } finally {
        if (!failed) {
          this.observer.emit({
            level: "debug",
            event: "http_request_completed",
            traceId,
            ...correlation,
            durationMs: Date.now() - startedAt,
            outcome: "succeeded",
            data: {
              method,
              path: url.pathname,
              operation,
              statusCode: response.statusCode,
            },
          });
        }
      }
    });
  }
}

function requestCorrelation(request: IncomingMessage): {
  requestId?: string;
  sessionId?: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
} {
  return {
    ...headerValue(request, "x-ayati-request-id", "requestId"),
    ...headerValue(request, "x-ayati-session-id", "sessionId"),
    ...headerValue(request, "x-ayati-conversation-id", "conversationId"),
    ...headerValue(request, "x-ayati-run-id", "runId"),
    ...headerValue(request, "x-ayati-task-id", "taskId"),
  };
}

function headerValue<K extends string>(
  request: IncomingMessage,
  header: string,
  key: K,
): Partial<Record<K, string>> {
  const value = request.headers[header]?.toString().trim();
  return value ? { [key]: value } as Record<K, string> : {};
}

function requestOperation(method: string, pathname: string): string {
  if (method === "GET" && pathname === "/health") return "health";
  if (method === "GET" && pathname === "/context/active") return "get_active_context";
  if (pathname === "/context/turns/prepare") return "prepare_context_turn";
  if (pathname === "/context/turns/complete") return "complete_context_turn";
  if (pathname === "/sessions/ensure-active") return "ensure_active_session";
  if (pathname === "/conversations/append") return "append_conversation";
  if (/\/sessions\/[^/]+\/attachments$/.test(pathname)) return "record_session_attachments";
  if (/\/task-attachments$/.test(pathname)) return "bind_task_attachments";
  if (/\/adopt-reference$/.test(pathname)) return "adopt_task_reference";
  if (pathname === "/task-runs/create") return "create_task_run";
  if (pathname === "/task-runs/activate") return "activate_task_run";
  if (pathname === "/runs/start") return "start_run";
  if (/\/steps$/.test(pathname)) return "record_run_step";
  if (/\/finalize-task$/.test(pathname)) return "finalize_task_run";
  if (/\/finalize-session$/.test(pathname)) return "finalize_session_run";
  if (/\/verify$/.test(pathname)) return "verify_mutation";
  if (/mutation-authority$/.test(pathname)) return "acquire_mutation_authority";
  if (method === "GET" && pathname === "/tasks") return "list_tasks";
  if (pathname.startsWith("/tasks/")) return "get_task";
  return "unknown";
}

function isKnownPath(pathname: string): boolean {
  return pathname === "/health"
    || pathname === "/context/active"
    || pathname === "/context/turns/prepare"
    || pathname === "/context/turns/complete"
    || pathname === "/sessions/ensure-active"
    || pathname === "/conversations/append"
    || pathname === "/tasks"
    || pathname === "/task-runs/create"
    || pathname === "/task-runs/activate"
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
  const serviceError = normalizeServiceError(error);
  sendJson(response, errorStatusCode(serviceError.code), serviceError.toResponse());
}

function normalizeServiceError(error: unknown): GitContextServiceError {
  return error instanceof GitContextServiceError
    ? error
    : new GitContextServiceError({
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unexpected Git Context Engine error.",
      });
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
    if (await isSocketAcceptingConnections(socketPath)) {
      const error = new Error("Git Context Engine socket is already owned by a live server: " + socketPath);
      (error as NodeJS.ErrnoException).code = "EADDRINUSE";
      throw error;
    }
    await rm(socketPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ path: socketPath });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
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
