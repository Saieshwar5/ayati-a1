import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type ActiveContext,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type GetActiveContextRequest,
  type GetTaskRequest,
  type GetTaskResponse,
  type HealthResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type StartRunRequest,
  type StartRunResponse,
} from "./contracts.js";
import { GitContextServiceError } from "./errors.js";
import type { GitContextService } from "./service.js";

export class ContractOnlyGitContextService implements GitContextService {
  async getHealth(): Promise<HealthResponse> {
    return {
      service: "ayati-git-context",
      protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
      status: "degraded",
      ready: false,
      capabilities: ["health"],
    };
  }

  async getActiveContext(_input: GetActiveContextRequest): Promise<ActiveContext> {
    throw notReady();
  }

  async ensureActiveSession(
    _input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    throw notReady();
  }

  async appendConversation(
    _input: AppendConversationRequest,
  ): Promise<AppendConversationResponse> {
    throw notReady();
  }

  async createTask(_input: CreateTaskRequest): Promise<CreateTaskResponse> {
    throw notReady();
  }

  async getTask(_input: GetTaskRequest): Promise<GetTaskResponse> {
    throw notReady();
  }

  async startRun(_input: StartRunRequest): Promise<StartRunResponse> {
    throw notReady();
  }

  async recordRunStep(_input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    throw notReady();
  }
}

function notReady(): GitContextServiceError {
  return new GitContextServiceError({
    code: "SERVICE_NOT_READY",
    message: "Git Context Engine persistence is not configured yet.",
    retryable: false,
  });
}
