import { lstat, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { dirname } from "node:path";
import {
  isActivateWorkstreamForRunRequest,
  isBindResourcesForRunRequest,
  isCreateWorkstreamForRunRequest,
  isEnsureActiveSessionRequest,
  isFinalizeRunRequest,
  isInspectResourceForRunRequest,
  isReadWorkstreamRequest,
  isSetWorkstreamStarRequest,
  isPlanWorkstreamRequestRouteRequest,
  isPrepareContextTurnRequest,
  isRecordRunStepRequest,
  isPrepareResourceMutationRequest,
  isVerifyResourceMutationRequest,
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

      if (method === "POST" && url.pathname === "/sessions/ensure-active") {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isEnsureActiveSessionRequest(body)) {
          throw invalidRequest("Invalid ensure-active session request.");
        }
        sendJson(response, 200, await this.service.ensureActiveSession(body));
        return;
      }

      if (method === "GET" && url.pathname === "/workstreams") {
        const query = url.searchParams.get("query")?.trim();
        const limitText = url.searchParams.get("limit")?.trim();
        const limit = limitText ? Number(limitText) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
          throw invalidRequest("Workstream list limit must be between 1 and 100.");
        }
        sendJson(response, 200, await this.service.listWorkstreams({
          ...(query ? { query } : {}),
          ...(limit ? { limit } : {}),
        }));
        return;
      }

      if (method === "GET" && url.pathname === "/workstreams/find") {
        const query = url.searchParams.get("query")?.trim();
        const paths = url.searchParams.getAll("path").map((path) => path.trim()).filter(Boolean);
        const view = url.searchParams.get("view")?.trim();
        const allowedViews = new Set(["relevant", "unfinished", "starred", "recent", "frequent"]);
        if (view && !allowedViews.has(view)) {
          throw invalidRequest("Unknown workstream discovery view.");
        }
        const limitText = url.searchParams.get("limit")?.trim();
        const limit = limitText ? Number(limitText) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
          throw invalidRequest("Workstream discovery limit must be between 1 and 50.");
        }
        if (paths.length > 20 || paths.some((path) => path.length > 4_096)) {
          throw invalidRequest("Workstream discovery accepts at most 20 bounded paths.");
        }
        const sessionId = url.searchParams.get("sessionId")?.trim();
        const currentText = url.searchParams.get("currentText")?.trim();
        const includeArchived = url.searchParams.get("includeArchived") === "true";
        sendJson(response, 200, await this.service.findWorkstreams({
          ...(query ? { query } : {}),
          ...(paths.length > 0 ? { paths } : {}),
          ...(view ? { view: view as "relevant" | "unfinished" | "starred" | "recent" | "frequent" } : {}),
          ...(includeArchived ? { includeArchived: true } : {}),
          ...(limit ? { limit } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(currentText ? { currentText } : {}),
        }));
        return;
      }

      const createWorkstreamMatch = url.pathname.match(/^\/runs\/([^/]+)\/workstreams\/create$/);
      if (method === "POST" && createWorkstreamMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isCreateWorkstreamForRunRequest(body)) {
          throw invalidRequest("Invalid create-workstream-for-run request.");
        }
        const runId = decodePathComponent(createWorkstreamMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.createWorkstreamForRun(body));
        return;
      }

      const activateWorkstreamMatch = url.pathname.match(/^\/runs\/([^/]+)\/workstreams\/activate$/);
      if (method === "POST" && activateWorkstreamMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isActivateWorkstreamForRunRequest(body)) {
          throw invalidRequest("Invalid activate-workstream-for-run request.");
        }
        const runId = decodePathComponent(activateWorkstreamMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.activateWorkstreamForRun(body));
        return;
      }

      const requestRouteMatch = url.pathname.match(/^\/runs\/([^/]+)\/workstream-request-route$/);
      if (method === "POST" && requestRouteMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isPlanWorkstreamRequestRouteRequest(body)) {
          throw invalidRequest("Invalid workstream-request-route request.");
        }
        const runId = decodePathComponent(requestRouteMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.planWorkstreamRequestRoute(body));
        return;
      }

      const workstreamMatch = url.pathname.match(/^\/workstreams\/([^/]+)$/);
      if (method === "GET" && workstreamMatch) {
        const workstreamId = decodePathComponent(workstreamMatch[1] ?? "");
        sendJson(response, 200, await this.service.getWorkstream({ workstreamId }));
        return;
      }

      const workstreamOpenMatch = url.pathname.match(/^\/workstreams\/([^/]+)\/open$/);
      if (method === "POST" && workstreamOpenMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isReadWorkstreamRequest(body)) {
          throw invalidRequest("Invalid read-workstream request.");
        }
        const workstreamId = decodePathComponent(workstreamOpenMatch[1] ?? "");
        if (body.workstreamId !== workstreamId) {
          throw invalidRequest("Workstream ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.readWorkstream(body));
        return;
      }

      const workstreamStarMatch = url.pathname.match(/^\/workstreams\/([^/]+)\/star$/);
      if (method === "POST" && workstreamStarMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isSetWorkstreamStarRequest(body)) {
          throw invalidRequest("Invalid set-workstream-star request.");
        }
        const workstreamId = decodePathComponent(workstreamStarMatch[1] ?? "");
        if (body.workstreamId !== workstreamId) {
          throw invalidRequest("Workstream ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.setWorkstreamStar(body));
        return;
      }

      if (method === "GET" && url.pathname === "/resources/find") {
        const query = url.searchParams.get("query")?.trim();
        const resourceIds = url.searchParams.getAll("resourceId").map((value) => value.trim()).filter(Boolean);
        const locators = url.searchParams.getAll("locator").map((value) => value.trim()).filter(Boolean);
        const workstreamId = url.searchParams.get("workstreamId")?.trim();
        const includeMissing = url.searchParams.get("includeMissing") === "true";
        const limitText = url.searchParams.get("limit")?.trim();
        const limit = limitText ? Number(limitText) : undefined;
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
          throw invalidRequest("Resource search limit must be between 1 and 100.");
        }
        sendJson(response, 200, await this.service.findResources({
          ...(query ? { query } : {}),
          ...(resourceIds.length > 0 ? { resourceIds } : {}),
          ...(locators.length > 0 ? { locators } : {}),
          ...(workstreamId ? { workstreamId } : {}),
          ...(includeMissing ? { includeMissing: true } : {}),
          ...(limit ? { limit } : {}),
        }));
        return;
      }

      const inspectResourceMatch = url.pathname.match(/^\/runs\/([^/]+)\/resources\/inspect$/);
      if (method === "POST" && inspectResourceMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isInspectResourceForRunRequest(body)) {
          throw invalidRequest("Invalid inspect-resource request.");
        }
        const runId = decodePathComponent(inspectResourceMatch[1] ?? "");
        if (body.runId !== runId) throw invalidRequest("Run ID in path and body must match.");
        sendJson(response, 200, await this.service.inspectResourceForRun(body));
        return;
      }

      const bindResourcesMatch = url.pathname.match(/^\/runs\/([^/]+)\/resources\/bind$/);
      if (method === "POST" && bindResourcesMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isBindResourcesForRunRequest(body)) {
          throw invalidRequest("Invalid bind-resources request.");
        }
        const runId = decodePathComponent(bindResourcesMatch[1] ?? "");
        if (body.runId !== runId) throw invalidRequest("Run ID in path and body must match.");
        sendJson(response, 200, await this.service.bindResourcesForRun(body));
        return;
      }

      const prepareMutationMatch = url.pathname.match(/^\/runs\/([^/]+)\/resource-mutations\/prepare$/);
      if (method === "POST" && prepareMutationMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isPrepareResourceMutationRequest(body)) {
          throw invalidRequest("Invalid prepare-resource-mutation request.");
        }
        const runId = decodePathComponent(prepareMutationMatch[1] ?? "");
        if (body.runId !== runId) throw invalidRequest("Run ID in path and body must match.");
        sendJson(response, 200, await this.service.prepareResourceMutation(body));
        return;
      }

      const verifyResourceMutationMatch = url.pathname.match(
        /^\/resource-mutations\/([^/]+)\/verify$/,
      );
      if (method === "POST" && verifyResourceMutationMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isVerifyResourceMutationRequest(body)) {
          throw invalidRequest("Invalid verify-resource-mutation request.");
        }
        const operationId = decodePathComponent(verifyResourceMutationMatch[1] ?? "");
        if (body.operationId !== operationId) {
          throw invalidRequest("Mutation operation ID in path and body must match.");
        }
        sendJson(response, 200, await this.service.verifyResourceMutation(body));
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

      const finalizeRunMatch = url.pathname.match(/^\/runs\/([^/]+)\/finalize$/);
      if (method === "POST" && finalizeRunMatch) {
        const body = await readJsonBody(request, this.maxBodyBytes);
        if (!isFinalizeRunRequest(body)) {
          throw invalidRequest("Invalid run finalization request.");
        }
        const runId = decodePathComponent(finalizeRunMatch[1] ?? "");
        if (body.runId !== runId) {
          throw invalidRequest("Run ID in request path and body must match.");
        }
        sendJson(response, 200, await this.service.finalizeRun(body));
        return;
      }

      const knownPath = isKnownPath(url.pathname)
        || Boolean(runStepMatch)
        || Boolean(workstreamMatch)
        || Boolean(inspectResourceMatch)
        || Boolean(bindResourcesMatch)
        || Boolean(prepareMutationMatch)
        || Boolean(verifyResourceMutationMatch)
        || Boolean(createWorkstreamMatch)
        || Boolean(activateWorkstreamMatch)
        || Boolean(finalizeRunMatch);
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
  workstreamId?: string;
} {
  return {
    ...headerValue(request, "x-ayati-request-id", "requestId"),
    ...headerValue(request, "x-ayati-session-id", "sessionId"),
    ...headerValue(request, "x-ayati-conversation-id", "conversationId"),
    ...headerValue(request, "x-ayati-run-id", "runId"),
    ...headerValue(request, "x-ayati-workstream-id", "workstreamId"),
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
  if (pathname === "/sessions/ensure-active") return "ensure_active_session";
  if (pathname === "/resources/find") return "find_resources";
  if (/\/resources\/inspect$/.test(pathname)) return "inspect_resource_for_run";
  if (/\/resources\/bind$/.test(pathname)) return "bind_resources_for_run";
  if (/\/resource-mutations\/prepare$/.test(pathname)) return "prepare_resource_mutation";
  if (/\/workstreams\/create$/.test(pathname)) return "create_workstream_for_run";
  if (/\/workstreams\/activate$/.test(pathname)) return "activate_workstream_for_run";
  if (/\/steps$/.test(pathname)) return "record_run_step";
  if (/\/finalize$/.test(pathname)) return "finalize_run";
  if (/\/resource-mutations\/[^/]+\/verify$/.test(pathname)) return "verify_resource_mutation";
  if (method === "GET" && pathname === "/workstreams") return "list_workstreams";
  if (pathname.startsWith("/workstreams/")) return "get_workstream";
  return "unknown";
}

function isKnownPath(pathname: string): boolean {
  return pathname === "/health"
    || pathname === "/context/active"
    || pathname === "/context/turns/prepare"
    || pathname === "/sessions/ensure-active"
    || pathname === "/workstreams"
    || pathname === "/resources/find";
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
    case "WORKSTREAM_NOT_FOUND":
      return 404;
    case "METHOD_NOT_ALLOWED":
      return 405;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "SESSION_HEAD_MISMATCH":
    case "IDEMPOTENCY_CONFLICT":
    case "RUN_ALREADY_ACTIVE":
    case "WORKSTREAM_LOCKED":
    case "WORKSTREAM_CHECKOUT_DIRTY":
    case "WORKSTREAM_HEAD_MISMATCH":
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
