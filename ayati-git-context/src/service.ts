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
  FindTasksRequest,
  FindTasksResponse,
  GetActiveContextRequest,
  GetTaskRequest,
  GetTaskResponse,
  HealthResponse,
  InspectTaskLocationRequest,
  InspectTaskLocationResponse,
  ListTasksRequest,
  ListTasksResponse,
  PlanTaskRequestRouteRequest,
  PlanTaskRequestRouteResponse,
  PrepareContextTurnRequest,
  PrepareContextTurnResponse,
  ReadTaskRequest,
  ReadTaskResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RecordSessionAttachmentsRequest,
  RecordSessionAttachmentsResponse,
  SelectedTaskForRunResponse,
  SetTaskStarRequest,
  SetTaskStarResponse,
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
  findTasks(input: FindTasksRequest): Promise<FindTasksResponse>;
  inspectTaskLocation(input: InspectTaskLocationRequest): Promise<InspectTaskLocationResponse>;
  getTask(input: GetTaskRequest): Promise<GetTaskResponse>;
  readTask(input: ReadTaskRequest): Promise<ReadTaskResponse>;
  setTaskStar(input: SetTaskStarRequest): Promise<SetTaskStarResponse>;
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
