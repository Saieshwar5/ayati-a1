import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type ActivateTaskRunRequest,
  type ActiveContext,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
  type CheckpointMutationRequest,
  type CheckpointMutationResponse,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
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
  type MountTaskRequest,
  type MountTaskResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type SnapshotTaskRunEvidenceRequest,
  type SnapshotTaskRunEvidenceResponse,
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

  async createTaskRun(_input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    throw notReady();
  }

  async activateTaskRun(_input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse> {
    throw notReady();
  }

  async listTasks(_input: ListTasksRequest): Promise<ListTasksResponse> {
    throw notReady();
  }

  async getTask(_input: GetTaskRequest): Promise<GetTaskResponse> {
    throw notReady();
  }

  async mountTask(_input: MountTaskRequest): Promise<MountTaskResponse> {
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

  async checkpointMutation(
    _input: CheckpointMutationRequest,
  ): Promise<CheckpointMutationResponse> {
    throw notReady();
  }

  async snapshotTaskRunEvidence(
    _input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse> {
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
