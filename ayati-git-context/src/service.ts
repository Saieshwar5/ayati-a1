import type {
  ActiveContext,
  ActivateWorkstreamForRunRequest,
  BindResourcesForRunRequest,
  BindResourcesForRunResponse,
  CreateWorkstreamForRunRequest,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  FinalizeRunRequest,
  FinalizeRunResponse,
  FindWorkstreamsRequest,
  FindWorkstreamsResponse,
  FindResourcesRequest,
  FindResourcesResponse,
  GetActiveContextRequest,
  GetWorkstreamRequest,
  GetWorkstreamResponse,
  HealthResponse,
  InspectResourceForRunRequest,
  InspectResourceForRunResponse,
  ListWorkstreamsRequest,
  ListWorkstreamsResponse,
  PlanWorkstreamRequestRouteRequest,
  PlanWorkstreamRequestRouteResponse,
  PrepareContextTurnRequest,
  PrepareContextTurnResponse,
  ReadWorkstreamRequest,
  ReadWorkstreamResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  PrepareResourceMutationRequest,
  PrepareResourceMutationResponse,
  SelectedWorkstreamForRunResponse,
  SetWorkstreamStarRequest,
  SetWorkstreamStarResponse,
  VerifyResourceMutationRequest,
  VerifyResourceMutationResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  prepareContextTurn(input: PrepareContextTurnRequest): Promise<PrepareContextTurnResponse>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
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
