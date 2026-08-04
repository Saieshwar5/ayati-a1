import type {
  ActivateWorkstreamForRunRequest,
  AgentContextProjection,
  BindResourcesForRunRequest,
  BindResourcesForRunResponse,
  CheckpointRunWorkStateRequest,
  CheckpointRunWorkStateResponse,
  CommitContextCheckpointRequest,
  CommitContextCheckpointResponse,
  CreateWorkstreamForRunRequest,
  FinalizeRunRequest,
  FinalizeRunResponse,
  FindResourcesRequest,
  FindResourcesResponse,
  FindWorkstreamsRequest,
  FindWorkstreamsResponse,
  GetAgentContextRequest,
  GetWorkstreamRequest,
  GetWorkstreamResponse,
  ContextEngineHealth,
  InspectResourceForRunRequest,
  InspectResourceForRunResponse,
  ListWorkstreamsRequest,
  ListWorkstreamsResponse,
  PlanContextCheckpointRequest,
  PlanWorkstreamRequestRouteRequest,
  PlanWorkstreamRequestRouteResponse,
  PrepareAgentRunRequest,
  PrepareAgentRunResponse,
  PrepareResourceMutationRequest,
  PrepareResourceMutationResponse,
  ReadAgentConversationRequest,
  ReadAgentConversationResponse,
  ReadAgentHistoryRequest,
  ReadAgentHistoryResponse,
  ReadWorkstreamRequest,
  ReadWorkstreamResponse,
  ReadWorkstreamRepositoryCommitRequest,
  ReadWorkstreamRepositoryCommitResponse,
  ReadWorkstreamRepositoryDiffRequest,
  ReadWorkstreamRepositoryDiffResponse,
  ReadWorkstreamRepositoryLogRequest,
  ReadWorkstreamRepositoryLogResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  SearchAgentHistoryRequest,
  SearchAgentHistoryResponse,
  SelectedWorkstreamForRunResponse,
  SetWorkstreamStarRequest,
  SetWorkstreamStarResponse,
  VerifyResourceMutationRequest,
  VerifyResourceMutationResponse,
  ContextCheckpointPlan,
} from "./contracts.js";

export interface ContextEngineService {
  getHealth(): Promise<ContextEngineHealth>;
  getAgentContext(input: GetAgentContextRequest): Promise<AgentContextProjection>;
  prepareAgentRun(input: PrepareAgentRunRequest): Promise<PrepareAgentRunResponse>;
  planContextCheckpoint(input: PlanContextCheckpointRequest): Promise<ContextCheckpointPlan>;
  commitContextCheckpoint(
    input: CommitContextCheckpointRequest,
  ): Promise<CommitContextCheckpointResponse>;
  searchAgentHistory(input: SearchAgentHistoryRequest): Promise<SearchAgentHistoryResponse>;
  readAgentConversation(
    input: ReadAgentConversationRequest,
  ): Promise<ReadAgentConversationResponse>;
  readAgentHistory(input: ReadAgentHistoryRequest): Promise<ReadAgentHistoryResponse>;
  createWorkstreamForRun(input: CreateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse>;
  activateWorkstreamForRun(input: ActivateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse>;
  planWorkstreamRequestRoute(
    input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse>;
  listWorkstreams(input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse>;
  findWorkstreams(input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse>;
  getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse>;
  readWorkstream(input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse>;
  readWorkstreamRepositoryLog(
    input: ReadWorkstreamRepositoryLogRequest,
  ): Promise<ReadWorkstreamRepositoryLogResponse>;
  readWorkstreamRepositoryCommit(
    input: ReadWorkstreamRepositoryCommitRequest,
  ): Promise<ReadWorkstreamRepositoryCommitResponse>;
  readWorkstreamRepositoryDiff(
    input: ReadWorkstreamRepositoryDiffRequest,
  ): Promise<ReadWorkstreamRepositoryDiffResponse>;
  setWorkstreamStar(input: SetWorkstreamStarRequest): Promise<SetWorkstreamStarResponse>;
  findResources(input: FindResourcesRequest): Promise<FindResourcesResponse>;
  inspectResourceForRun(input: InspectResourceForRunRequest): Promise<InspectResourceForRunResponse>;
  bindResourcesForRun(input: BindResourcesForRunRequest): Promise<BindResourcesForRunResponse>;
  prepareResourceMutation(
    input: PrepareResourceMutationRequest,
  ): Promise<PrepareResourceMutationResponse>;
  verifyResourceMutation(
    input: VerifyResourceMutationRequest,
  ): Promise<VerifyResourceMutationResponse>;
  finalizeRun(input: FinalizeRunRequest): Promise<FinalizeRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
  checkpointRunWorkState(
    input: CheckpointRunWorkStateRequest,
  ): Promise<CheckpointRunWorkStateResponse>;
}
