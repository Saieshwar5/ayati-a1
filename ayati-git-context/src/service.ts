import type {
  ActiveContext,
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  CheckpointMutationRequest,
  CheckpointMutationResponse,
  AppendConversationRequest,
  AppendConversationResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  GetActiveContextRequest,
  GetTaskRequest,
  GetTaskResponse,
  HealthResponse,
  MountTaskRequest,
  MountTaskResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  SnapshotTaskRunEvidenceRequest,
  SnapshotTaskRunEvidenceResponse,
  StartRunRequest,
  StartRunResponse,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
  appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(input: GetTaskRequest): Promise<GetTaskResponse>;
  mountTask(input: MountTaskRequest): Promise<MountTaskResponse>;
  acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse>;
  verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse>;
  checkpointMutation(input: CheckpointMutationRequest): Promise<CheckpointMutationResponse>;
  snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
