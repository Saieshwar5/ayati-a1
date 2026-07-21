import type {
  ActivateWorkstreamForRunRequest,
  AgentContextProjection,
  BindResourcesForRunRequest,
  BindResourcesForRunResponse,
  CommitContextCheckpointRequest,
  CommitContextCheckpointResponse,
  CommitWorkstreamResolutionRequest,
  CommitWorkstreamResolutionResponse,
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
  GetWorkstreamResolutionRequest,
  GetWorkstreamResolutionResponse,
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
  ReadAgentHistoryRequest,
  ReadAgentHistoryResponse,
  ReadWorkstreamRequest,
  ReadWorkstreamResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  RecordWorkstreamResolutionStepRequest,
  RecordWorkstreamResolutionStepResponse,
  SearchAgentHistoryRequest,
  SearchAgentHistoryResponse,
  SelectedWorkstreamForRunResponse,
  SetWorkstreamStarRequest,
  SetWorkstreamStarResponse,
  StartWorkstreamResolutionRequest,
  StartWorkstreamResolutionResponse,
  FinishWorkstreamResolutionRequest,
  FinishWorkstreamResolutionResponse,
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
  readAgentHistory(input: ReadAgentHistoryRequest): Promise<ReadAgentHistoryResponse>;
  startWorkstreamResolution(
    input: StartWorkstreamResolutionRequest,
  ): Promise<StartWorkstreamResolutionResponse>;
  recordWorkstreamResolutionStep(
    input: RecordWorkstreamResolutionStepRequest,
  ): Promise<RecordWorkstreamResolutionStepResponse>;
  commitWorkstreamResolution(
    input: CommitWorkstreamResolutionRequest,
  ): Promise<CommitWorkstreamResolutionResponse>;
  finishWorkstreamResolution(
    input: FinishWorkstreamResolutionRequest,
  ): Promise<FinishWorkstreamResolutionResponse>;
  getWorkstreamResolution(
    input: GetWorkstreamResolutionRequest,
  ): Promise<GetWorkstreamResolutionResponse>;
  createWorkstreamForRun(input: CreateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse>;
  activateWorkstreamForRun(input: ActivateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse>;
  planWorkstreamRequestRoute(
    input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse>;
  listWorkstreams(input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse>;
  findWorkstreams(input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse>;
  getWorkstream(input: GetWorkstreamRequest): Promise<GetWorkstreamResponse>;
  readWorkstream(input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse>;
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
}
