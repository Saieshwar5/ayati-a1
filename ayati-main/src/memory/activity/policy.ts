import type { ActivityKind, ActivityLifecycle, ActivityUpsertInput } from "./types.js";

export function inferActivityKind(input: ActivityUpsertInput): ActivityKind {
  const text = [
    input.objective,
    input.summary,
    input.progressSummary,
    input.currentFocus,
    input.userMessage,
    input.actionType,
    ...(input.entityHints ?? []),
    ...(input.attachmentNames ?? []),
    ...(input.activityAssets ?? []).flatMap((asset) => [
      asset.kind,
      asset.displayName,
      asset.path,
      asset.documentId,
      asset.fileId,
      asset.directoryId,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();

  const hasDurableAnchor = (input.activityAssets?.length ?? 0) > 0 || (input.attachmentNames?.length ?? 0) > 0;
  if (!hasDurableAnchor && isEphemeralText(text)) {
    return "ephemeral";
  }
  if ((input.activityAssets ?? []).some((asset) => asset.kind === "document" || asset.kind === "dataset")
    || /\b(pdf|document|attachment|contract|policy|paper|dataset|spreadsheet|csv)\b/.test(text)) {
    return "document";
  }
  if (/\b(learn|learning|teach|lesson|study|course|practice|understand)\b/.test(text)) {
    return "learning";
  }
  if (/\b(reminder|routine|schedule|scheduled|automation|pulse|recurring|every day|daily|weekly)\b/.test(text)) {
    return "automation";
  }
  if (/\b(error|bug|debug|failing|failed|stack trace|exception|diagnose|fix issue)\b/.test(text)) {
    return "debug";
  }
  if (/\b(research|compare|investigate|analysis|decision|plan|evaluate)\b/.test(text)) {
    return "research";
  }
  if (/\b(file|files|directory|folder|repo|app|project|website|component|code|build|test|css|html|js|typescript)\b/.test(text)) {
    return "project";
  }
  return "generic";
}

export function shouldCreateActivity(input: ActivityUpsertInput, kind: ActivityKind): boolean {
  if (input.activityId?.trim()) return true;
  if ((input.toolsUsed?.length ?? 0) > 0) return true;
  if ((input.activityAssets?.length ?? 0) > 0 || (input.attachmentNames?.length ?? 0) > 0) return true;
  if ((kind === "automation" || kind === "learning") && hasArtifactEvidence(input)) return true;
  return false;
}

export function classifyLifecycle(input: {
  kind: ActivityKind;
  lastTouchedAt: string;
  openWorkCount: number;
  reuseCount: number;
  now: Date;
}): ActivityLifecycle {
  const ageDays = Math.max(0, (input.now.getTime() - Date.parse(input.lastTouchedAt)) / 86_400_000);
  if (input.openWorkCount > 0 || ageDays <= activeDays(input.kind)) {
    return "active";
  }
  if (ageDays <= warmDays(input.kind) || input.reuseCount > 2) {
    return "warm";
  }
  if (ageDays <= coldDays(input.kind)) {
    return "cold";
  }
  return "archived";
}

export function autoLoadUntil(kind: ActivityKind, lastTouchedAt: string): string {
  const base = Date.parse(lastTouchedAt);
  return new Date(base + activeDays(kind) * 86_400_000).toISOString();
}

export function defaultImportance(kind: ActivityKind): number {
  switch (kind) {
    case "automation":
      return 0.9;
    case "learning":
      return 0.82;
    case "project":
      return 0.78;
    case "document":
      return 0.72;
    case "debug":
      return 0.68;
    case "research":
      return 0.66;
    case "ephemeral":
      return 0.22;
    case "generic":
      return 0.45;
  }
}

export function deterministicScore(input: {
  identityMatches: number;
  aliasMatches: number;
  textScore: number;
  recencyScore: number;
  followUp: boolean;
  hasDurableAnchor: boolean;
}): number {
  const exact = input.identityMatches > 0 ? 0.72 + Math.min(0.16, input.identityMatches * 0.04) : 0;
  const alias = input.aliasMatches > 0 ? 0.42 + Math.min(0.16, input.aliasMatches * 0.04) : 0;
  const text = Math.min(0.62, input.textScore * 0.62);
  const followUpBoost = input.followUp ? 0.12 : 0;
  const anchorBoost = input.hasDurableAnchor ? 0.08 : 0;
  return round3(Math.min(0.99, Math.max(exact, alias, text) + input.recencyScore + followUpBoost + anchorBoost));
}

export function isFollowUpMessage(message: string): boolean {
  return /\b(continue|resume|again|same|that|this|it|previous|last|earlier|follow up|what about|next|finish|carry on)\b/i.test(message);
}

export function hasExplicitNewTaskSignal(message: string): boolean {
  return /\b(new|different|start over|from scratch|unrelated|another)\b/i.test(message);
}

export function shouldUseEphemeralHistory(message: string): boolean {
  return /\b(history|historical|trend|compare|comparison|previous|last time|earlier|before)\b/i.test(message);
}

function hasArtifactEvidence(input: ActivityUpsertInput): boolean {
  const text = [
    input.summary,
    input.progressSummary,
    ...(input.evidence ?? []),
    ...(input.keyFacts ?? []),
    ...(input.completedMilestones ?? []),
  ].join(" ").toLowerCase();
  return /\b(file|files|directory|folder|created|written|edited|modified|verified|hash|artifact|app|component|build|test|path)\b/.test(text);
}

function isEphemeralText(text: string): boolean {
  return /\b(machine|system|computer|laptop|device|health|status|diagnostic|diagnostics|ram|memory|cpu|disk|storage|battery|network|process|processes|programs|usage|load|uptime|date|time|weather now|current weather)\b/.test(text)
    && /\b(check|show|what|which|current|now|today|usage|using|health|status|diagnose|diagnostic)\b/.test(text);
}

function activeDays(kind: ActivityKind): number {
  switch (kind) {
    case "automation":
      return 90;
    case "learning":
      return 45;
    case "project":
      return 21;
    case "document":
      return 10;
    case "debug":
      return 5;
    case "research":
      return 7;
    case "ephemeral":
      return 0;
    case "generic":
      return 2;
  }
}

function warmDays(kind: ActivityKind): number {
  switch (kind) {
    case "automation":
      return 365;
    case "learning":
      return 180;
    case "project":
      return 90;
    case "document":
      return 45;
    case "debug":
      return 21;
    case "research":
      return 30;
    case "ephemeral":
      return 1;
    case "generic":
      return 7;
  }
}

function coldDays(kind: ActivityKind): number {
  switch (kind) {
    case "automation":
      return 730;
    case "learning":
      return 365;
    case "project":
      return 365;
    case "document":
      return 180;
    case "debug":
      return 90;
    case "research":
      return 120;
    case "ephemeral":
      return 7;
    case "generic":
      return 30;
  }
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}
