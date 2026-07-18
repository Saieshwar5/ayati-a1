import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AdoptTaskReferenceRequest,
  type AdoptTaskReferenceResponse,
  type ActivateTaskRunRequest,
  type ActiveContext,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type BindTaskAttachmentsRequest,
  type BindTaskAttachmentsResponse,
  type CompleteContextTurnRequest,
  type CompleteContextTurnResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeSessionRunRequest,
  type FinalizeSessionRunResponse,
  type FinalizeTaskRunRequest,
  type FinalizeTaskRunResponse,
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
  type StartRunRequest,
  type StartRunResponse,
  type SelectedTaskRunResponse,
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

  async completeContextTurn(
    _input: CompleteContextTurnRequest,
  ): Promise<CompleteContextTurnResponse> {
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

  async createTaskRun(_input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    throw notReady();
  }

  async activateTaskRun(_input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse> {
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

  async finalizeTaskRun(_input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse> {
    throw notReady();
  }

  async finalizeSessionRun(
    _input: FinalizeSessionRunRequest,
  ): Promise<FinalizeSessionRunResponse> {
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
