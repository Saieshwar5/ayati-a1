export type SubsessionStatus =
  | "created"
  | "running"
  | "waiting_for_plan_update"
  | "paused"
  | "failed"
  | "completed"
  | "archived";

export type SubsessionTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type SubsessionEndStatus = "solved" | "partial" | "stuck";

export interface SubsessionMeta {
  id: string;
  clientId: string;
  parentSessionId: string;
  parentRunId: string;
  goalSummary: string;
  status: SubsessionStatus;
  revision: number;
  relatedToSubsessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubsessionTaskVerification {
  pass: boolean;
  score: number;
  gap: string;
  rationale: string;
}

export interface SubsessionTaskReflection {
  failureReason: string;
  strategyDelta: string;
  nextInstruction: string;
}

export interface SubsessionTaskAttempt {
  attempt: number;
  startedAt: string;
  endedAt: string;
  output: string;
  outputSummary: string;
  endStatus: SubsessionEndStatus;
  totalSteps: number;
  toolCallsMade: number;
  verification: SubsessionTaskVerification;
  reflection?: SubsessionTaskReflection;
}

export interface SubsessionTask {
  id: string;
  title: string;
  objective: string;
  expectedOutput: string;
  status: SubsessionTaskStatus;
  attempts: SubsessionTaskAttempt[];
  createdAt: string;
  updatedAt: string;
}

export interface SubsessionPlan {
  goal: string;
  doneCriteria: string;
  constraints: string[];
  tasks: SubsessionTask[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: "llm";
}

export interface SubsessionState {
  currentTaskIndex: number;
  currentTaskId?: string;
  currentAttempt: number;
  totalSteps: number;
  totalToolCalls: number;
  maxAttemptsPerTask: number;
  maxTotalSteps: number;
  maxNoProgressCycles: number;
  noProgressCycles: number;
  modeStatus: SubsessionStatus;
  lastCheckpoint: string;
}

export interface SubsessionProgressEvent {
  ts: string;
  subsessionId: string;
  type:
    | "subsession_started"
    | "subsession_resumed"
    | "plan_ready"
    | "plan_updated"
    | "task_started"
    | "task_completed"
    | "task_failed"
    | "subsession_failed"
    | "subsession_completed";
  message: string;
  taskId?: string;
  taskTitle?: string;
  revision?: number;
}

export interface SubsessionLogEvent {
  ts: string;
  subsessionId: string;
  event:
    | "meta_update"
    | "plan_write"
    | "state_write"
    | "task_write"
    | "verification_write"
    | "attempt_result"
    | "failure_write"
    | "end_write"
    | "lock_acquired"
    | "lock_released";
  details: Record<string, unknown>;
}

export interface SubsessionFailureReport {
  subsessionId: string;
  status: "failed";
  failedTaskId: string;
  failedTaskTitle: string;
  attempts: number;
  rootCause: string;
  lastCheckpoint: string;
  recommendedNextStep: string;
  createdAt: string;
}

export interface SubsessionEndReport {
  subsessionId: string;
  status: "completed";
  endStatus: "solved" | "partial";
  finalAnswer: string;
  completedTaskIds: string[];
  unresolvedItems: string[];
  verificationEvidenceFiles: string[];
  createdAt: string;
}

export interface SubsessionSnapshot {
  dirPath: string;
  meta: SubsessionMeta;
  plan: SubsessionPlan;
  state: SubsessionState;
}

export interface PlannedTaskInput {
  title: string;
  objective: string;
  expectedOutput: string;
}
