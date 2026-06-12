import type { FocusAdmissionResult, FocusType, FocusUpsertInput } from "./types.js";

const CREATE_THRESHOLD = 30;

export function inferFocusType(input: FocusUpsertInput): FocusType {
  const text = [
    input.objective,
    input.summary,
    input.progressSummary,
    input.currentFocus,
    input.userMessage,
    input.actionType,
    ...(input.entityHints ?? []),
    ...(input.attachmentNames ?? []),
  ].filter(Boolean).join(" ").toLowerCase();

  if ((input.activeAttachments?.length ?? 0) > 0 || (input.attachmentNames?.length ?? 0) > 0 || /\b(pdf|document|attachment|contract|policy|paper)\b/.test(text)) {
    return "document";
  }
  if (/\b(learn|learning|teach|lesson|study|course|practice|understand)\b/.test(text)) {
    return "learning";
  }
  if (/\b(reminder|routine|schedule|scheduled|automation|pulse|recurring|every day|daily|weekly)\b/.test(text)) {
    return "automation";
  }
  if (/\b(error|bug|debug|failing|failed|stack trace|exception|diagnose|fix issue)\b/.test(text)) {
    return "debug_issue";
  }
  if (/\b(research|compare|investigate|analysis|decision|plan|evaluate)\b/.test(text)) {
    return "investigation";
  }
  if (/\b(file|files|directory|app|project|website|component|code|build|test|css|html|js|typescript)\b/.test(text)) {
    return "artifact_work";
  }
  return "generic_task";
}

export function defaultDecayRate(type: FocusType): number {
  switch (type) {
    case "automation":
      return 0.005;
    case "learning":
      return 0.01;
    case "artifact_work":
      return 0.02;
    case "document":
      return 0.035;
    case "debug_issue":
      return 0.05;
    case "investigation":
      return 0.04;
    case "generic_task":
      return 0.08;
  }
}

export function defaultMemoryStrength(type: FocusType): number {
  switch (type) {
    case "automation":
      return 0.9;
    case "learning":
      return 0.85;
    case "artifact_work":
      return 0.8;
    case "document":
      return 0.75;
    case "debug_issue":
      return 0.7;
    case "investigation":
      return 0.72;
    case "generic_task":
      return 0.6;
  }
}

export function admitFocus(input: FocusUpsertInput, type: FocusType): FocusAdmissionResult {
  let score = 0;
  const reasons: string[] = [];

  if ((input.activeAttachments?.length ?? 0) > 0 || (input.attachmentNames?.length ?? 0) > 0) {
    score += 35;
    reasons.push("document_or_attachment_present");
  }
  if (hasArtifactEvidence(input)) {
    score += 35;
    reasons.push("artifact_evidence");
  }
  if (type === "automation") {
    score += 40;
    reasons.push("automation_focus");
  }
  if (type === "learning") {
    score += 30;
    reasons.push("learning_progress");
  }
  if ((input.openWork?.length ?? 0) > 0 || input.userInputNeeded?.trim()) {
    score += 25;
    reasons.push("open_work");
  }
  if (hasExplicitFutureIntent(input)) {
    score += 30;
    reasons.push("explicit_future_intent");
  }
  if ((input.evidence?.length ?? 0) > 0 || (input.keyFacts?.length ?? 0) > 0) {
    score += 15;
    reasons.push("verified_or_reported_facts");
  }
  if (looksOneOff(input)) {
    score -= 40;
    reasons.push("one_off");
  }
  if (!hasDurableState(input, type)) {
    score -= 20;
    reasons.push("no_durable_state");
  }
  if (input.status === "failed" && !hasDurableState(input, type)) {
    score -= 20;
    reasons.push("failed_without_state");
  }

  return {
    admitted: score >= CREATE_THRESHOLD,
    score,
    reason: reasons.join(",") || "no_signals",
  };
}

export function calculateAttentionScore(input: {
  memoryStrength: number;
  decayRate: number;
  importance: number;
  reuseCount: number;
  lastTouchedAt: string;
  openWorkCount: number;
  now: Date;
}): number {
  const ageDays = Math.max(0, (input.now.getTime() - Date.parse(input.lastTouchedAt)) / 86_400_000);
  const decay = Math.exp(-input.decayRate * ageDays);
  const importanceBoost = Math.min(0.12, input.importance * 0.08);
  const reuseBoost = Math.min(0.16, input.reuseCount * 0.04);
  const openWorkBoost = input.openWorkCount > 0 ? 0.2 : 0;
  return round4(Math.max(0, Math.min(1.2, input.memoryStrength * decay + importanceBoost + reuseBoost + openWorkBoost)));
}

export function statusFromAttentionScore(score: number): "active" | "warm" | "dormant" | "archived" {
  if (score >= 0.85) return "active";
  if (score >= 0.5) return "warm";
  if (score >= 0.28) return "dormant";
  return "archived";
}

function hasArtifactEvidence(input: FocusUpsertInput): boolean {
  const text = [
    input.summary,
    input.progressSummary,
    ...(input.evidence ?? []),
    ...(input.keyFacts ?? []),
    ...(input.completedMilestones ?? []),
  ].join(" ").toLowerCase();
  return /\b(file|files|directory|created|written|edited|modified|verified|hash|artifact|app|component|build|test)\b/.test(text);
}

function hasExplicitFutureIntent(input: FocusUpsertInput): boolean {
  const text = [
    input.userMessage,
    input.nextAction,
    input.userInputNeeded,
    ...(input.openWork ?? []),
  ].filter(Boolean).join(" ").toLowerCase();
  return /\b(continue|resume|next|later|remember|follow up|open work|remaining|todo|need to)\b/.test(text);
}

function looksOneOff(input: FocusUpsertInput): boolean {
  const text = [input.objective, input.userMessage, input.summary].filter(Boolean).join(" ").toLowerCase();
  return /\b(what is|who is|when is|capital of|calculate|2\+2|simple answer)\b/.test(text)
    && (input.openWork?.length ?? 0) === 0
    && (input.attachmentNames?.length ?? 0) === 0;
}

function hasDurableState(input: FocusUpsertInput, type: FocusType): boolean {
  if (type === "learning" || type === "automation") return true;
  return (input.activeAttachments?.length ?? 0) > 0
    || (input.attachmentNames?.length ?? 0) > 0
    || (input.openWork?.length ?? 0) > 0
    || (input.evidence?.length ?? 0) > 0
    || (input.keyFacts?.length ?? 0) > 0
    || hasArtifactEvidence(input);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

