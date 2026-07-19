import { request as httpRequest, type RequestOptions } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  ActiveContext,
  ActivateWorkstreamForRunRequest,
  BindResourcesForRunRequest,
  BindResourcesForRunResponse,
  CreateWorkstreamForRunRequest,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  FinalizeRunRequest,
  FinalizeRunResponse,
  FindWorkstreamsRequest,
  FindWorkstreamsResponse,
  FindResourcesRequest,
  FindResourcesResponse,
  GetActiveContextRequest,
  GetWorkstreamRequest,
  GetWorkstreamResponse,
  HealthResponse,
  InspectResourceForRunRequest,
  InspectResourceForRunResponse,
  ListWorkstreamsRequest,
  ListWorkstreamsResponse,
  PlanWorkstreamRequestRouteRequest,
  PlanWorkstreamRequestRouteResponse,
  PrepareContextTurnRequest,
  PrepareContextTurnResponse,
  ReadWorkstreamRequest,
  ReadWorkstreamResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  PrepareResourceMutationRequest,
  PrepareResourceMutationResponse,
  SelectedWorkstreamForRunResponse,
  SetWorkstreamStarRequest,
  SetWorkstreamStarResponse,
  VerifyResourceMutationRequest,
  VerifyResourceMutationResponse,
} from "./contracts.js";
import {
  GitContextServiceError,
  isGitContextErrorResponse,
} from "./errors.js";
import type { GitContextService } from "./service.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
    return await this.requestJson<ActiveContext>(
      "GET",
      "/context/active" + query,
      undefined,
      input,
    );
  }

  async prepareContextTurn(
    input: PrepareContextTurnRequest,
  ): Promise<PrepareContextTurnResponse> {
    return await this.requestJson<PrepareContextTurnResponse>(
      "POST",
      "/context/turns/prepare",
      input,
    );
  }

  async ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse> {
    return await this.requestJson<EnsureActiveSessionResponse>(
      "POST",
      "/sessions/ensure-active",
      input,
    );
  }

  async createWorkstreamForRun(input: CreateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse> {
    return await this.requestJson<SelectedWorkstreamForRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/workstreams/create",
      input,
    );
  }

  async activateWorkstreamForRun(input: ActivateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse> {
    return await this.requestJson<SelectedWorkstreamForRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/workstreams/activate",
      input,
    );
  }

  async planWorkstreamRequestRoute(
    input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse> {
    return await this.requestJson<PlanWorkstreamRequestRouteResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/workstream-request-route",
      input,
    );
  }

  async listWorkstreams(input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.size > 0 ? "?" + params.toString() : "";
    return await this.requestJson<ListWorkstreamsResponse>("GET", "/workstreams" + query);
  }

  async findWorkstreams(input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    for (const path of input.paths ?? []) params.append("path", path);
    if (input.view) params.set("view", input.view);
    if (input.includeArchived) params.set("includeArchived", "true");
    if (input.limit) params.set("limit", String(input.limit));
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.currentText) params.set("currentText", input.currentText);
    const query = params.size > 0 ? "?" + params.toString() : "";
    return await this.requestJson<FindWorkstreamsResponse>("GET", "/workstreams/find" + query);
  }

  async getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    return await this.requestJson<GetWorkstreamResponse>(
      "GET",
      "/workstreams/" + encodeURIComponent(input.workstreamId),
    );
  }

  async readWorkstream(input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse> {
    return await this.requestJson<ReadWorkstreamResponse>(
      "POST",
      "/workstreams/" + encodeURIComponent(input.workstreamId) + "/open",
      input,
    );
  }

  async setWorkstreamStar(input: SetWorkstreamStarRequest): Promise<SetWorkstreamStarResponse> {
    return await this.requestJson<SetWorkstreamStarResponse>(
      "POST",
      "/workstreams/" + encodeURIComponent(input.workstreamId) + "/star",
      input,
    );
  }

  async findResources(input: FindResourcesRequest): Promise<FindResourcesResponse> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    for (const resourceId of input.resourceIds ?? []) params.append("resourceId", resourceId);
    for (const locator of input.locators ?? []) params.append("locator", locator);
    if (input.workstreamId) params.set("workstreamId", input.workstreamId);
    if (input.includeMissing) params.set("includeMissing", "true");
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.size > 0 ? "?" + params.toString() : "";
    return await this.requestJson<FindResourcesResponse>("GET", "/resources/find" + query);
  }

  async inspectResourceForRun(
    input: InspectResourceForRunRequest,
  ): Promise<InspectResourceForRunResponse> {
    return await this.requestJson<InspectResourceForRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/resources/inspect",
      input,
    );
  }

  async bindResourcesForRun(
    input: BindResourcesForRunRequest,
  ): Promise<BindResourcesForRunResponse> {
    return await this.requestJson<BindResourcesForRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/resources/bind",
      input,
    );
  }

  async prepareResourceMutation(
    input: PrepareResourceMutationRequest,
  ): Promise<PrepareResourceMutationResponse> {
    return await this.requestJson<PrepareResourceMutationResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/resource-mutations/prepare",
      input,
    );
  }

  async verifyResourceMutation(
    input: VerifyResourceMutationRequest,
  ): Promise<VerifyResourceMutationResponse> {
    return await this.requestJson<VerifyResourceMutationResponse>(
      "POST",
      "/resource-mutations/" + encodeURIComponent(input.operationId) + "/verify",
      input,
    );
  }

  async finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    return await this.requestJson<FinalizeRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/finalize",
      input,
    );
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return await this.requestJson<RecordRunStepResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/steps",
      input,
    );
  }

  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    input?: unknown,
    observabilityInput: unknown = input,
  ): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const traceId = requestTraceId(input);
    const options: RequestOptions = {
      method,
      path,
      headers: {
        accept: "application/json",
        "x-ayati-trace-id": traceId,
        ...requestCorrelationHeaders(observabilityInput),
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

function requestCorrelationHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const record = input as Record<string, unknown>;
  return {
    ...stringHeader("x-ayati-request-id", record["requestId"]),
    ...stringHeader("x-ayati-session-id", record["sessionId"]),
    ...stringHeader("x-ayati-conversation-id", record["conversationId"]),
    ...stringHeader("x-ayati-run-id", record["runId"]),
    ...stringHeader("x-ayati-workstream-id", record["workstreamId"]),
  };
}

function stringHeader(name: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value.trim()
    ? { [name]: value.trim() }
    : {};
}

function requestTraceId(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const requestId = (input as Record<string, unknown>)["requestId"];
    if (typeof requestId === "string" && requestId.trim()) return requestId;
  }
  return randomUUID();
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
