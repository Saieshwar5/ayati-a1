import {
  type ActivateWorkstreamForRunRequest,
  type AgentContextProjection,
  type BindResourcesForRunRequest,
  type BindResourcesForRunResponse,
  type CommitContextCheckpointRequest,
  type CommitContextCheckpointResponse,
  type CommitWorkstreamResolutionRequest,
  type CommitWorkstreamResolutionResponse,
  type ContextCheckpointPlan,
  type CreateWorkstreamForRunRequest,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type FindResourcesRequest,
  type FindResourcesResponse,
  type FindWorkstreamsRequest,
  type FindWorkstreamsResponse,
  type GetAgentContextRequest,
  type GetWorkstreamRequest,
  type GetWorkstreamResponse,
  type GetWorkstreamResolutionRequest,
  type GetWorkstreamResolutionResponse,
  type ContextEngineHealth,
  type InspectResourceForRunRequest,
  type InspectResourceForRunResponse,
  type ListWorkstreamsRequest,
  type ListWorkstreamsResponse,
  type PlanContextCheckpointRequest,
  type PlanWorkstreamRequestRouteRequest,
  type PlanWorkstreamRequestRouteResponse,
  type PrepareAgentRunRequest,
  type PrepareAgentRunResponse,
  type PrepareResourceMutationRequest,
  type PrepareResourceMutationResponse,
  type ReadAgentHistoryRequest,
  type ReadAgentHistoryResponse,
  type ReadWorkstreamRequest,
  type ReadWorkstreamResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type RecordWorkstreamResolutionStepRequest,
  type RecordWorkstreamResolutionStepResponse,
  type SearchAgentHistoryRequest,
  type SearchAgentHistoryResponse,
  type SelectedWorkstreamForRunResponse,
  type SetWorkstreamStarRequest,
  type SetWorkstreamStarResponse,
  type StartWorkstreamResolutionRequest,
  type StartWorkstreamResolutionResponse,
  type FinishWorkstreamResolutionRequest,
  type FinishWorkstreamResolutionResponse,
  type VerifyResourceMutationRequest,
  type VerifyResourceMutationResponse,
} from "./contracts.js";
import { ContextEngineServiceError } from "./errors.js";
import type { ContextEngineService } from "./service.js";

export class ContractOnlyContextEngineService implements ContextEngineService {
  async getHealth(): Promise<ContextEngineHealth> {
    return {
      service: "ayati-context-engine",
      status: "degraded",
      ready: false,
      capabilities: ["health"],
    };
  }

  async getAgentContext(_input: GetAgentContextRequest): Promise<AgentContextProjection> {
    throw notReady();
  }

  async prepareAgentRun(_input: PrepareAgentRunRequest): Promise<PrepareAgentRunResponse> {
    throw notReady();
  }

  async planContextCheckpoint(
    _input: PlanContextCheckpointRequest,
  ): Promise<ContextCheckpointPlan> {
    throw notReady();
  }

  async commitContextCheckpoint(
    _input: CommitContextCheckpointRequest,
  ): Promise<CommitContextCheckpointResponse> {
    throw notReady();
  }

  async searchAgentHistory(
    _input: SearchAgentHistoryRequest,
  ): Promise<SearchAgentHistoryResponse> {
    throw notReady();
  }

  async readAgentHistory(_input: ReadAgentHistoryRequest): Promise<ReadAgentHistoryResponse> {
    throw notReady();
  }

  async startWorkstreamResolution(
    _input: StartWorkstreamResolutionRequest,
  ): Promise<StartWorkstreamResolutionResponse> {
    throw notReady();
  }

  async recordWorkstreamResolutionStep(
    _input: RecordWorkstreamResolutionStepRequest,
  ): Promise<RecordWorkstreamResolutionStepResponse> {
    throw notReady();
  }

  async commitWorkstreamResolution(
    _input: CommitWorkstreamResolutionRequest,
  ): Promise<CommitWorkstreamResolutionResponse> {
    throw notReady();
  }

  async finishWorkstreamResolution(
    _input: FinishWorkstreamResolutionRequest,
  ): Promise<FinishWorkstreamResolutionResponse> {
    throw notReady();
  }

  async getWorkstreamResolution(
    _input: GetWorkstreamResolutionRequest,
  ): Promise<GetWorkstreamResolutionResponse> {
    throw notReady();
  }

  async createWorkstreamForRun(_input: CreateWorkstreamForRunRequest): Promise<SelectedWorkstreamForRunResponse> {
    throw notReady();
  }

  async activateWorkstreamForRun(
    _input: ActivateWorkstreamForRunRequest,
  ): Promise<SelectedWorkstreamForRunResponse> {
    throw notReady();
  }

  async planWorkstreamRequestRoute(
    _input: PlanWorkstreamRequestRouteRequest,
  ): Promise<PlanWorkstreamRequestRouteResponse> {
    throw notReady();
  }

  async listWorkstreams(_input: ListWorkstreamsRequest): Promise<ListWorkstreamsResponse> {
    throw notReady();
  }

  async findWorkstreams(_input: FindWorkstreamsRequest): Promise<FindWorkstreamsResponse> {
    throw notReady();
  }

  async getWorkstream(_input: GetWorkstreamRequest): Promise<GetWorkstreamResponse> {
    throw notReady();
  }

  async readWorkstream(_input: ReadWorkstreamRequest): Promise<ReadWorkstreamResponse> {
    throw notReady();
  }

  async setWorkstreamStar(_input: SetWorkstreamStarRequest): Promise<SetWorkstreamStarResponse> {
    throw notReady();
  }

  async findResources(_input: FindResourcesRequest): Promise<FindResourcesResponse> {
    throw notReady();
  }

  async inspectResourceForRun(
    _input: InspectResourceForRunRequest,
  ): Promise<InspectResourceForRunResponse> {
    throw notReady();
  }

  async bindResourcesForRun(
    _input: BindResourcesForRunRequest,
  ): Promise<BindResourcesForRunResponse> {
    throw notReady();
  }

  async prepareResourceMutation(
    _input: PrepareResourceMutationRequest,
  ): Promise<PrepareResourceMutationResponse> {
    throw notReady();
  }

  async verifyResourceMutation(
    _input: VerifyResourceMutationRequest,
  ): Promise<VerifyResourceMutationResponse> {
    throw notReady();
  }

  async finalizeRun(_input: FinalizeRunRequest): Promise<FinalizeRunResponse> {
    throw notReady();
  }

  async recordRunStep(_input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    throw notReady();
  }
}

function notReady(): ContextEngineServiceError {
  return new ContextEngineServiceError({
    code: "SERVICE_NOT_READY",
    message: "Context Engine persistence is not configured yet.",
    retryable: false,
  });
}
