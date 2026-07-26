export const WORK_STATE_STATUSES = [
  "in_progress",
  "needs_user_input",
  "blocked",
  "done",
] as const;

export type WorkStatus = typeof WORK_STATE_STATUSES[number];

export const WORK_PLAN_ITEM_STATUSES = [
  "pending",
  "active",
  "done",
  "blocked",
] as const;

export type WorkPlanItemStatus = typeof WORK_PLAN_ITEM_STATUSES[number];

export interface WorkPlanItem {
  id: string;
  task: string;
  status: WorkPlanItemStatus;
}

export const IMPORTANT_CONTEXT_KINDS = [
  "artifact",
  "decision",
  "finding",
  "constraint",
] as const;

export type ImportantContextKind = typeof IMPORTANT_CONTEXT_KINDS[number];

export interface ImportantContextItem {
  kind: ImportantContextKind;
  value: string;
  ref?: string;
}

export interface WorkState {
  status: WorkStatus;
  summary: string;
  plan: WorkPlanItem[];
  importantContext: ImportantContextItem[];
  nextAction?: string;
}

export const WORK_STATE_UPDATE_REASONS = [
  "initial",
  "plan",
  "context_pressure",
  "run_completed",
  "run_paused",
  "continuation",
] as const;

export type WorkStateUpdateReason = typeof WORK_STATE_UPDATE_REASONS[number];

export interface WorkStateRuntimeMetadata {
  revision: number;
  afterStep: number;
  updateReason: WorkStateUpdateReason;
  updatedAt?: string;
}

export interface WorkStateUpdateInput {
  reason: Extract<WorkStateUpdateReason, "plan" | "context_pressure">;
  summary: string;
  plan: WorkPlanItem[];
  importantContext: ImportantContextItem[];
  nextAction?: string;
}

export const WORK_STATE_LIMITS = {
  summaryChars: 1_000,
  planItems: 12,
  planIdChars: 32,
  planTaskChars: 240,
  importantContextItems: 12,
  importantContextValueChars: 320,
  importantContextRefChars: 500,
  nextActionChars: 320,
} as const;

export function emptyWorkState(): WorkState {
  return {
    status: "in_progress",
    summary: "Run started.",
    plan: [],
    importantContext: [],
  };
}
