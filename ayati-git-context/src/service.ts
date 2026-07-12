import type {
  ActiveContext,
  AppendConversationRequest,
  AppendConversationResponse,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  GetActiveContextRequest,
  HealthResponse,
  RecordRunStepRequest,
  RecordRunStepResponse,
  StartRunRequest,
  StartRunResponse,
} from "./contracts.js";

export interface GitContextService {
  getHealth(): Promise<HealthResponse>;
  getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext>;
  ensureActiveSession(input: EnsureActiveSessionRequest): Promise<EnsureActiveSessionResponse>;
  appendConversation(input: AppendConversationRequest): Promise<AppendConversationResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
