import type { ToolCallVerificationRecord } from "../ivec/agent-runner/tool-call-verification-contracts.js";
import type {
  ToolErrorCategory,
  ToolOperationStatus,
} from "../skills/types.js";

export type ContextStepStatus = "completed" | "failed" | "skipped";

export interface ContextStepToolCallRecord {
  callId?: string;
  tool: string;
  purpose?: string;
  status: "success" | "failed";
  input: unknown;
  output?: string;
  error?: string;
  code?: string;
  errorCategory?: ToolErrorCategory;
  errorTarget?: string;
  operationStatus?: ToolOperationStatus;
  verification?: ToolCallVerificationRecord;
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
  facts: string[];
  artifacts: string[];
  outputSize?: number;
  lineCount?: number;
  truncated?: boolean;
  failureType?: string;
  blockedTargets?: string[];
}
