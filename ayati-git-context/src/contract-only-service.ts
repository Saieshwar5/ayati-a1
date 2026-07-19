import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type ActivateWorkstreamForRunRequest,
  type ActiveContext,
  type BindResourcesForRunRequest,
  type BindResourcesForRunResponse,
  type CreateWorkstreamForRunRequest,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type FinalizeRunRequest,
  type FinalizeRunResponse,
  type FindWorkstreamsRequest,
  type FindWorkstreamsResponse,
  type FindResourcesRequest,
  type FindResourcesResponse,
  type GetActiveContextRequest,
  type GetWorkstreamRequest,
  type GetWorkstreamResponse,
  type HealthResponse,
  type InspectResourceForRunRequest,
  type InspectResourceForRunResponse,
  type ListWorkstreamsRequest,
  type ListWorkstreamsResponse,
  type PlanWorkstreamRequestRouteRequest,
  type PlanWorkstreamRequestRouteResponse,
  type PrepareContextTurnRequest,
  type PrepareContextTurnResponse,
  type ReadWorkstreamRequest,
  type ReadWorkstreamResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type PrepareResourceMutationRequest,
  type PrepareResourceMutationResponse,
  type SelectedWorkstreamForRunResponse,
  type SetWorkstreamStarRequest,
  type SetWorkstreamStarResponse,
  type VerifyResourceMutationRequest,
  type VerifyResourceMutationResponse,
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

  async prepareContextTurn(
    _input: PrepareContextTurnRequest,
  ): Promise<PrepareContextTurnResponse> {
    throw notReady();
  }

  async ensureActiveSession(
    _input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
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

function notReady(): GitContextServiceError {
  return new GitContextServiceError({
    code: "SERVICE_NOT_READY",
    message: "Git Context Engine persistence is not configured yet.",
    retryable: false,
  });
}
