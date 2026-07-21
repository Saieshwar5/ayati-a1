import type {
  ContextCheckpointPlan,
  ContextCheckpointRecord,
} from "ayati-context-engine";
import type { LlmCostEstimate, LlmTokenUsage } from "../../core/contracts/llm-protocol.js";
import type { ContextBudgetReport } from "../../prompt/context-budget.js";
import type { StreamCheckpointGenerationResult } from "../agent-runner/stream-checkpoint-generator.js";

export type ContextLane = "system" | "session" | "work";

export type ContextRetention =
  | "exact"
  | "hot"
  | "referenceable"
  | "summarizable";

export interface PromptContextPart {
  id: string;
  lane: ContextLane;
  retention: ContextRetention;
  content: unknown;
  sourceRefs: string[];
  localEstimatedTokens: number;
}

export interface PromptContextManifest {
  policyVersion: number;
  parts: PromptContextPart[];
  laneEstimates: Record<ContextLane, number>;
  toolSchemaTokens: number;
  totalLocalEstimate: number;
}

export type ContextPreparationLaneId = `main:${string}` | `resolver:${string}`;

export type ContextPreparationCandidateStatus =
  | "preparing"
  | "ready"
  | "adopted"
  | "stale"
  | "failed"
  | "discarded";

export type ContextPreparationCandidateKind =
  | "durable_checkpoint"
  | "run_focus"
  | "resolver_focus";

export interface AnchoredFocusStatement {
  text: string;
  refs: string[];
}

export interface RunFocusSummary {
  schemaVersion: 1;
  coveredMessageRange?: { fromSeq: number; toSeq: number };
  coveredStepRange?: { fromStep: number; toStep: number };
  goal: string;
  constraints: AnchoredFocusStatement[];
  decisions: AnchoredFocusStatement[];
  completedWork: AnchoredFocusStatement[];
  importantFindings: AnchoredFocusStatement[];
  artifacts: AnchoredFocusStatement[];
  unresolvedQuestions: AnchoredFocusStatement[];
  references: string[];
}

export interface ContextPreparationBackgroundUsage {
  durationMs: number;
  attempts: number;
  usage?: LlmTokenUsage;
  cost?: LlmCostEstimate;
}

export interface ContextPreparationCandidate {
  candidateId: string;
  jobKey: string;
  laneId: ContextPreparationLaneId;
  kind: ContextPreparationCandidateKind;
  status: ContextPreparationCandidateStatus;
  messagePrefixThroughSeq?: number;
  runStepPrefixThrough?: number;
  canonicalSourceHashes: Record<string, string>;
  sourceRefs: string[];
  requiredExactEvidenceRefs: string[];
  policyVersion: number;
  modelProfileVersion: string;
  checkpointBaseId?: string;
  deterministicTransformations: string[];
  focusSummary?: RunFocusSummary;
  checkpointPlan?: ContextCheckpointPlan;
  checkpointGeneration?: StreamCheckpointGenerationResult;
  adoptedCheckpoint?: ContextCheckpointRecord;
  coveredSourceRefs: string[];
  estimatedSavingsTokens: number;
  estimatedFinalInputTokens: number;
  targetReached: boolean;
  background?: ContextPreparationBackgroundUsage;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  lifecycleReason?: string;
}

export interface ContextPreparationEvent {
  event:
    | "context_manifest_measured"
    | "context_preparation_triggered"
    | "context_preparation_skipped"
    | "context_preparation_deduplicated"
    | "context_candidate_ready"
    | "context_candidate_adopted"
    | "context_candidate_stale"
    | "context_candidate_failed"
    | "context_candidate_discarded"
    | "context_candidate_validated"
    | "context_background_summary_completed"
    | "context_synchronous_fallback"
    | "context_limit_termination";
  laneId: ContextPreparationLaneId;
  at: string;
  data: Record<string, unknown>;
}

export interface ContextPreparationReceiptData {
  manifest: PromptContextManifest;
  candidateManifest?: PromptContextManifest;
  preparationInputTokens: number;
  forcedBarrierTokens: number;
  nextDecisionReserveTokens: number;
  preparationLeadTokens: number;
  candidate?: Pick<
    ContextPreparationCandidate,
    "candidateId" | "laneId" | "kind" | "status" | "targetReached"
  >;
  candidateAction?: "none" | "measured" | "adopted" | "rejected" | "awaited";
  candidateReason?: string;
  background?: {
    triggered: boolean;
    deduplicated: boolean;
    overlappedForeground: boolean;
    usage?: ContextPreparationBackgroundUsage;
  };
  forcedRecovery: boolean;
  targetReached: boolean;
}

export interface ContextPreparationTriggerDecision {
  triggered: boolean;
  reason: "preparation_threshold" | "predicted_soft_pressure" | "below_threshold";
  predictedInputTokens: number;
}

export interface ContextPreparationAdmissionState {
  budget: ContextBudgetReport;
  forcedBarrierTokens: number;
  atForcedBarrier: boolean;
}

export const CONTEXT_PREPARATION_POLICY_VERSION = 1;
export const RUN_FOCUS_SUMMARY_MAX_TOKENS = 1_600;
