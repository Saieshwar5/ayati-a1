export const RUN_WORK_STATUSES = [
  "in_progress",
  "needs_user_input",
  "blocked",
  "done",
] as const;

export type RunWorkStatus = typeof RUN_WORK_STATUSES[number];

export const RUN_WORK_PLAN_ITEM_STATUSES = [
  "pending",
  "active",
  "done",
  "blocked",
] as const;

export type RunWorkPlanItemStatus = typeof RUN_WORK_PLAN_ITEM_STATUSES[number];

export interface RunWorkPlanItem {
  id: string;
  task: string;
  status: RunWorkPlanItemStatus;
}

export const RUN_IMPORTANT_CONTEXT_KINDS = [
  "artifact",
  "decision",
  "finding",
  "constraint",
] as const;

export type RunImportantContextKind = typeof RUN_IMPORTANT_CONTEXT_KINDS[number];

export interface RunImportantContextItem {
  kind: RunImportantContextKind;
  value: string;
  ref?: string;
}

export const RUN_WORK_STATE_UPDATE_REASONS = [
  "initial",
  "plan",
  "context_pressure",
  "run_completed",
  "run_paused",
  "continuation",
] as const;

export type RunWorkStateUpdateReason = typeof RUN_WORK_STATE_UPDATE_REASONS[number];

export interface RunWorkStateInput {
  status: RunWorkStatus;
  summary: string;
  plan: RunWorkPlanItem[];
  importantContext: RunImportantContextItem[];
  nextAction: string | null;
}

export interface RunWorkState extends RunWorkStateInput {
  runId: string;
  revision: number;
  afterStep: number;
  updateReason: RunWorkStateUpdateReason;
  updatedAt: string;
}
