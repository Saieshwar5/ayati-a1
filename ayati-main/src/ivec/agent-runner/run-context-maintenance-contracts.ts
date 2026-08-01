import type { PromptRunToolCallMode } from "./run-tool-call-context.js";
import type { ToolCallVerificationStatus } from "./tool-call-verification-contracts.js";
import type { ToolContextCompactionPolicy } from "./tool-context-projectors/types.js";
import { normalizeWorkStateUpdateInput } from "./work-state/checkpoint.js";
import type { WorkStateUpdateInput } from "./work-state/contracts.js";

export const RUN_CONTEXT_MAINTENANCE_LIMITS = {
  inventoryItems: 32,
  selectionRefs: 12,
} as const;

export interface RunContextMaintenanceCandidate {
  ref: string;
  step: number;
  callId?: string;
  tool: string;
  status: "success" | "failed";
  verificationStatus: ToolCallVerificationStatus;
  currentMode: PromptRunToolCallMode;
  policy: ToolContextCompactionPolicy;
  recommendedMode: PromptRunToolCallMode;
  mandatoryExact: boolean;
  mandatoryReason?: RunContextMandatoryExactReason;
  estimatedCurrentTokens: number;
  estimatedRecommendedTokens: number;
}

export type RunContextMandatoryExactReason =
  | "latest_six"
  | "failed_call"
  | "not_recoverable"
  | "workstate_reference"
  | "active_process"
  | "unknown_tool";

export interface RunContextMaintenancePlanEntry extends RunContextMaintenanceCandidate {
  index: number;
  aliases: string[];
}

export interface RunContextMaintenancePlan {
  schemaVersion: 1;
  maintenanceId: string;
  sourceHash: string;
  sourceThroughStep: number;
  expectedWorkStateRevision: number;
  candidateInputTokens: number;
  recoveryTargetTokens: number;
  requiredSavingsTokens: number;
  inventory: RunContextMaintenanceCandidate[];
  omittedCandidateCount: number;
  protectedRefs: string[];
  entries: RunContextMaintenancePlanEntry[];
}

export interface PromptRunContextMaintenanceCard {
  reason: "run_context_pressure";
  maintenanceId: string;
  returnTo: string;
  expectedWorkStateRevision: number;
  sourceThroughStep: number;
  requiredSavingsTokens: number;
  candidates: RunContextMaintenanceCandidate[];
  omittedCandidateCount: number;
  protectedRefs: string[];
}

export interface RunContextMaintenanceSelection {
  maintenanceId: string;
  expectedWorkStateRevision: number;
  workState: WorkStateUpdateInput;
  keepExactRefs: string[];
  keepCompactRefs: string[];
  releaseRefs: string[];
}

export interface RunContextProjectionOverlay {
  schemaVersion: 1;
  revision: number;
  sourceHash: string;
  sourceThroughStep: number;
  workStateRevision: number;
  modesByRef: Record<string, PromptRunToolCallMode>;
  requiredSavingsTokens: number;
  estimatedSavingsTokens: number;
  targetReached: boolean;
  maintainedAtIteration: number;
}

export function normalizeRunContextMaintenanceSelection(
  value: Record<string, unknown>,
): RunContextMaintenanceSelection {
  const workState = record(value["workState"], "workState");
  const selection = {
    maintenanceId: requiredText(value["maintenanceId"], "maintenanceId", 120),
    expectedWorkStateRevision: nonNegativeInteger(
      value["expectedWorkStateRevision"],
      "expectedWorkStateRevision",
    ),
    workState: normalizeWorkStateUpdateInput({
      ...workState,
      reason: "context_pressure",
    }),
    keepExactRefs: referenceList(value["keepExactRefs"], "keepExactRefs"),
    keepCompactRefs: referenceList(value["keepCompactRefs"], "keepCompactRefs"),
    releaseRefs: referenceList(value["releaseRefs"], "releaseRefs"),
  };
  assertDisjointSelections({
    keepExactRefs: selection.keepExactRefs,
    keepCompactRefs: selection.keepCompactRefs,
    releaseRefs: selection.releaseRefs,
  });
  return selection;
}

function referenceList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > RUN_CONTEXT_MAINTENANCE_LIMITS.selectionRefs) {
    throw new Error(
      `${field} must be an array with at most ${RUN_CONTEXT_MAINTENANCE_LIMITS.selectionRefs} references.`,
    );
  }
  const refs = value.map((item, index) => requiredText(item, `${field}[${index}]`, 240));
  if (new Set(refs).size !== refs.length) {
    throw new Error(`${field} must not contain duplicate references.`);
  }
  return refs;
}

function assertDisjointSelections(selection: Pick<
  RunContextMaintenanceSelection,
  "keepExactRefs" | "keepCompactRefs" | "releaseRefs"
>): void {
  const owner = new Map<string, string>();
  for (const [field, refs] of Object.entries(selection)) {
    for (const ref of refs) {
      const previous = owner.get(ref);
      if (previous) {
        throw new Error(`Run-context reference '${ref}' appears in both ${previous} and ${field}.`);
      }
      owner.set(ref, field);
    }
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  if (normalized.length > maximum) {
    throw new Error(`${field} must contain at most ${maximum} characters.`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return Number(value);
}
