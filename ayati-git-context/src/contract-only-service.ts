import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AdoptTaskReferenceRequest,
  type AdoptTaskReferenceResponse,
  type ActivateTaskForRunRequest,
  type ActiveContext,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type BindTaskAttachmentsRequest,
  type BindTaskAttachmentsResponse,
  type CreateTaskForRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type GetActiveContextRequest,
  type GetTaskRequest,
  type GetTaskResponse,
  type HealthResponse,
  type ListTasksRequest,
  type ListTasksResponse,
  type PlanTaskRequestRouteRequest,
  type PlanTaskRequestRouteResponse,
  type PrepareContextTurnRequest,
  type PrepareContextTurnResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordSessionAttachmentsRequest,
  type RecordSessionAttachmentsResponse,
  type SelectedTaskForRunResponse,
  type VerifyMutationRequest,
  type VerifyMutationResponse,
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

  async prepareContextTurn(
    _input: PrepareContextTurnRequest,
  ): Promise<PrepareContextTurnResponse> {
    throw notReady();
  }

  async ensureActiveSession(
    _input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    throw notReady();
  }

  async createTaskForRun(_input: CreateTaskForRunRequest): Promise<SelectedTaskForRunResponse> {
    throw notReady();
  }

  async activateTaskForRun(
    _input: ActivateTaskForRunRequest,
  ): Promise<SelectedTaskForRunResponse> {
    throw notReady();
  }

  async planTaskRequestRoute(
    _input: PlanTaskRequestRouteRequest,
  ): Promise<PlanTaskRequestRouteResponse> {
    throw notReady();
  }

  async listTasks(_input: ListTasksRequest): Promise<ListTasksResponse> {
    throw notReady();
  }

  async getTask(_input: GetTaskRequest): Promise<GetTaskResponse> {
    throw notReady();
  }

  async recordSessionAttachments(
    _input: RecordSessionAttachmentsRequest,
  ): Promise<RecordSessionAttachmentsResponse> {
    throw notReady();
  }

  async bindTaskAttachments(
    _input: BindTaskAttachmentsRequest,
  ): Promise<BindTaskAttachmentsResponse> {
    throw notReady();
  }

  async adoptTaskReference(
    _input: AdoptTaskReferenceRequest,
  ): Promise<AdoptTaskReferenceResponse> {
    throw notReady();
  }

  async acquireMutationAuthority(
    _input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    throw notReady();
  }

  async verifyMutation(_input: VerifyMutationRequest): Promise<VerifyMutationResponse> {
    throw notReady();
  }

  async finalizeRun(_input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
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
