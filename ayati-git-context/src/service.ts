import type {
  ActiveContext,
  AdoptTaskReferenceRequest,
  AdoptTaskReferenceResponse,
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  ActivateTaskForRunRequest,
  BindTaskAttachmentsRequest,
  BindTaskAttachmentsResponse,
  CreateTaskForRunRequest,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  FinalizeRunRequest,
  FinalizeRunResponse,
  GetActiveContextRequest,
  GetTaskRequest,
  GetTaskResponse,
  HealthResponse,
  ListTasksRequest,
  ListTasksResponse,
  PlanTaskRequestRouteRequest,
  PlanTaskRequestRouteResponse,
  PrepareContextTurnRequest,
  PrepareContextTurnResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RecordSessionAttachmentsRequest,
  RecordSessionAttachmentsResponse,
  SelectedTaskForRunResponse,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  prepareContextTurn(input: PrepareContextTurnRequest): Promise<PrepareContextTurnResponse>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
  createTaskForRun(input: CreateTaskForRunRequest): Promise<SelectedTaskForRunResponse>;
  activateTaskForRun(input: ActivateTaskForRunRequest): Promise<SelectedTaskForRunResponse>;
  planTaskRequestRoute(
    input: PlanTaskRequestRouteRequest,
  ): Promise<PlanTaskRequestRouteResponse>;
  listTasks(input: ListTasksRequest): Promise<ListTasksResponse>;
  getTask(input: GetTaskRequest): Promise<GetTaskResponse>;
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
  finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
