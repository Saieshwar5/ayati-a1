export type ContextStepStatus = "completed" | "failed" | "skipped";

export interface ContextStepToolCallRecord {
  callId?: string;
  tool: string;
  purpose?: string;
  status: "success" | "failed";
  input: unknown;
  output?: string;
  error?: string;
  [key: string]: unknown;
}

export interface ContextStepVerificationRecord {
  passed: boolean;
  summary: string;
  evidenceItems: string[];
  newFacts: string[];
  artifacts: string[];
  [key: string]: unknown;
}

export interface ContextRunStepRecord {
  v: 1;
  runId: string;
  taskId?: string;
  sessionId?: string;
  step: number;
  status: ContextStepStatus;
  startedAt?: string;
  completedAt: string;
  summary: string;
  decision?: Record<string, unknown>;
  action?: Record<string, unknown>;
  toolCalls: ContextStepToolCallRecord[];
  verification: ContextStepVerificationRecord;
  workStateAfter?: unknown;
  facts: string[];
  artifacts: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  failureType?: string;
  blockedTargets?: string[];
}
