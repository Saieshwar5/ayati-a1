import type {
  ActiveContext,
  AdoptTaskReferenceRequest,
  AdoptTaskReferenceResponse,
  AcquireMutationAuthorityRequest,
  AcquireMutationAuthorityResponse,
  CompleteContextTurnRequest,
  CompleteContextTurnResponse,
  AppendConversationRequest,
  AppendConversationResponse,
  ActivateTaskRunRequest,
  BindTaskAttachmentsRequest,
  BindTaskAttachmentsResponse,
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
  PlanTaskRequestRouteRequest,
  PlanTaskRequestRouteResponse,
  PrepareContextTurnRequest,
  PrepareContextTurnResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RecordSessionAttachmentsRequest,
  RecordSessionAttachmentsResponse,
  StartRunRequest,
  StartRunResponse,
  SelectedTaskRunResponse,
  VerifyMutationRequest,
  VerifyMutationResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  prepareContextTurn(input: PrepareContextTurnRequest): Promise<PrepareContextTurnResponse>;
  completeContextTurn(input: CompleteContextTurnRequest): Promise<CompleteContextTurnResponse>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
  appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse>;
  createTaskRun(input: CreateTaskRunRequest): Promise<SelectedTaskRunResponse>;
  activateTaskRun(input: ActivateTaskRunRequest): Promise<SelectedTaskRunResponse>;
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
  finalizeTaskRun(input: FinalizeTaskRunRequest): Promise<FinalizeTaskRunResponse>;
  finalizeSessionRun(input: FinalizeSessionRunRequest): Promise<FinalizeSessionRunResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
