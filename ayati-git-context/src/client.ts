import { request as httpRequest, type RequestOptions } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  ActiveContext,
  ActivateTaskRunRequest,
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  CheckpointMutationRequest,
  CheckpointMutationResponse,
  AppendConversationRequest,
  AppendConversationResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  CreateTaskRunRequest,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  FinalizeSessionRunRequest,
  FinalizeSessionRunResponse,
  FinalizeTaskRunRequest,
  FinalizeTaskRunResponse,
  GetActiveContextRequest,
  GetTaskRequest,
  GetTaskResponse,
  HealthResponse,
  ListTasksRequest,
  ListTasksResponse,
  MountTaskRequest,
  MountTaskResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  SnapshotTaskRunEvidenceRequest,
  SnapshotTaskRunEvidenceResponse,
  StartRunRequest,
  StartRunResponse,
  SelectedTaskRunResponse,
  VerifyMutationRequest,
  VerifyMutationResponse,
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

  async createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
    return await this.requestJson<CreateTaskResponse>("POST", "/tasks", input);
  }

  async createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.requestJson<SelectedTaskRunResponse>("POST", "/task-runs/create", input);
  }

  async activateTaskRun(input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    return await this.requestJson<SelectedTaskRunResponse>("POST", "/task-runs/activate", input);
  }

  async listTasks(input: ListTasksRequest): Promise<ListTasksResponse> {
    const params = new URLSearchParams();
    if (input.query) params.set("query", input.query);
    if (input.limit) params.set("limit", String(input.limit));
    const query = params.size > 0 ? "?" + params.toString() : "";
    return await this.requestJson<ListTasksResponse>("GET", "/tasks" + query);
  }

  async getTask(input: GetTaskRequest): Promise<GetTaskResponse> {
    return await this.requestJson<GetTaskResponse>(
      "GET",
      "/tasks/" + encodeURIComponent(input.taskId),
    );
  }

  async mountTask(input: MountTaskRequest): Promise<MountTaskResponse> {
    return await this.requestJson<MountTaskResponse>(
      "POST",
      "/sessions/" + encodeURIComponent(input.sessionId)
        + "/tasks/" + encodeURIComponent(input.taskId) + "/mount",
      input,
    );
  }

  async acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    return await this.requestJson<AcquireMutationAuthorityResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId)
        + "/tasks/" + encodeURIComponent(input.taskId) + "/mutation-authority",
      input,
    );
  }

  async verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    return await this.requestJson<VerifyMutationResponse>(
      "POST",
      "/mutation-authorities/" + encodeURIComponent(input.authorityId) + "/verify",
      input,
    );
  }

  async checkpointMutation(
    input: CheckpointMutationRequest,
  ): Promise<CheckpointMutationResponse> {
    return await this.requestJson<CheckpointMutationResponse>(
      "POST",
      "/mutation-authorities/" + encodeURIComponent(input.authorityId) + "/checkpoint",
      input,
    );
  }

  async snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
    return await this.requestJson<SnapshotTaskRunEvidenceResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/evidence/snapshot",
      input,
    );
  }

  async finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    return await this.requestJson<FinalizeTaskRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/finalize-task",
      input,
    );
  }

  async finalizeSessionRun(
    input: FinalizeSessionRunRequest,
  ): Promise<FinalizeSessionRunResponse> {
    return await this.requestJson<FinalizeSessionRunResponse>(
      "POST",
      "/runs/" + encodeURIComponent(input.runId) + "/finalize-session",
      input,
    );
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return await this.requestJson<StartRunResponse>("POST", "/runs/start", input);
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
    ...stringHeader("x-ayati-task-id", record["taskId"]),
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
