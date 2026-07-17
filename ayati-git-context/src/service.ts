import type {
  ActiveContext,
  AdoptTaskReferenceRequest,
  AdoptTaskReferenceResponse,
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  CheckpointMutationRequest,
  CheckpointMutationResponse,
  AppendConversationRequest,
  AppendConversationResponse,
  ActivateTaskRunRequest,
  BindTaskAttachmentsRequest,
  BindTaskAttachmentsResponse,
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
  RecordSessionAttachmentsRequest,
  RecordSessionAttachmentsResponse,
  SnapshotTaskRunEvidenceRequest,
  SnapshotTaskRunEvidenceResponse,
  StartRunRequest,
  StartRunResponse,
  SelectedTaskRunResponse,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
  appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse>;
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse>;
  activateTaskRun(input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse>;
  listTasks(input: ListTasksRequest): Promise<ListTasksResponse>;
  getTask(input: GetTaskRequest): Promise<GetTaskResponse>;
  mountTask(input: MountTaskRequest): Promise<MountTaskResponse>;
  recordSessionAttachments(
    input: RecordSessionAttachmentsRequest,
  ): Promise<RecordSessionAttachmentsResponse>;
  bindTaskAttachments(
    input: BindTaskAttachmentsRequest,
  ): Promise<BindTaskAttachmentsResponse>;
  adoptTaskReference(
    input: AdoptTaskReferenceRequest,
  ): Promise<AdoptTaskReferenceResponse>;
  acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse>;
  verifyMutation(input: VerifyMutationRequest): Promise<VerifyMutationResponse>;
  checkpointMutation(input: CheckpointMutationRequest): Promise<CheckpointMutationResponse>;
  snapshotTaskRunEvidence(
    input: SnapshotTaskRunEvidenceRequest,
  ): Promise<SnapshotTaskRunEvidenceResponse>;
  finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse>;
  finalizeSessionRun(input: FinalizeSessionRunRequest): Promise<FinalizeSessionRunResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
