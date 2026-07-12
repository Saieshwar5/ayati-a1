import type {
  ActiveContext,
  AppendConversationRequest,
  AppendConversationResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  EnsureActiveSessionRequest,
  EnsureActiveSessionResponse,
  GetActiveContextRequest,
  GetTaskRequest,
  GetTaskResponse,
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
  createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
  getTask(input: GetTaskRequest): Promise<GetTaskResponse>;
  startRun(input: StartRunRequest): Promise<StartRunResponse>;
  recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse>;
}
