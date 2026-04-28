import { DEFAULT_MEMORY_POLICY } from "./memory-policy.js";
import type { MemoryCard, MemoryDecayConfig, MemoryPolicy, MemoryScore } from "./types.js";
import { EVOLVING_MEMORY_SECTION_ID, TIME_BASED_SECTION_ID } from "./types.js";

export interface ScoreMemoryOptions {
  policy?: MemoryPolicy;
  activeSectionCount?: number;
}

export function scoreMemory(memory: MemoryCard, _now = new Date(), options?: ScoreMemoryOptions): MemoryScore {
  const policy = options?.policy ?? DEFAULT_MEMORY_POLICY;
  const decay = getMemoryDecayConfig(memory, policy);
  const freshness = freshnessForMemory(memory, _now, decay);
  const evidenceStrength = clamp(
    0.75 + (memory.confirmations * 0.1) - (memory.contradictions * 0.2),
    0.05,
    1.25,
  );
  const usefulness = (1 + memory.helpfulHits) / (1 + memory.helpfulHits + memory.harmfulHits);
  const urgency = urgencyForMemory(memory, _now);
  const pressureFactor = pressureFactorForMemory(memory, policy, options?.activeSectionCount);
  const currentConfidence = clamp(
    memory.confidence * memory.sourceReliability * evidenceStrength,
    0,
    1,
  );
  const retentionScore = clamp(
    currentConfidence * memory.importance * freshness * usefulness * urgency * pressureFactor,
    0,
    1,
  );

  return {
    freshness: round4(freshness),
    evidenceStrength: round4(evidenceStrength),
    usefulness: round4(usefulness),
    urgency: round4(urgency),
    pressureFactor: round4(pressureFactor),
    currentConfidence: round4(currentConfidence),
    retentionScore: round4(retentionScore),
    contextThreshold: round4(decay.contextThreshold),
    archiveThreshold: round4(decay.archiveThreshold),
  };
}

export function shouldInjectMemory(
  memory: MemoryCard,
  now = new Date(),
  minConfidence = 0.45,
  options?: ScoreMemoryOptions,
): boolean {
  if (memory.state !== "active") {
    return false;
  }
  if (isExpired(memory, now)) {
    return false;
  }
  const score = scoreMemory(memory, now, options);
  if (memory.sectionId !== EVOLVING_MEMORY_SECTION_ID) {
    return score.currentConfidence >= minConfidence;
  }
  return score.currentConfidence >= minConfidence && score.retentionScore >= score.contextThreshold;
}

export function isExpired(memory: MemoryCard, now = new Date()): boolean {
  if (memory.state === "expired") {
    return true;
  }
  if (!memory.expiresAt) {
    return false;
  }
  const expiresAt = Date.parse(memory.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

export function getMemoryDecayConfig(memory: MemoryCard, policy = DEFAULT_MEMORY_POLICY): MemoryDecayConfig {
  const base = defaultDecayForMemory(memory, policy);
  const raw = readDecayMetadata(memory);
  if (!raw) {
    return base;
  }
  const contextThreshold = clampNumber(raw["contextThreshold"], base.contextThreshold, 0.25, 0.75);
  return {
    curve: isDecayCurve(raw["curve"]) ? raw["curve"] : base.curve,
    graceDays: clampInteger(raw["graceDays"], base.graceDays, 0, 180),
    halfLifeDays: clampInteger(raw["halfLifeDays"], base.halfLifeDays, 1, 365),
    pressureSensitivity: clampNumber(raw["pressureSensitivity"], base.pressureSensitivity, 0, 1),
    contextThreshold,
    archiveThreshold: Math.min(
      clampNumber(raw["archiveThreshold"], base.archiveThreshold, 0.05, 0.35),
      Math.max(0.01, contextThreshold - 0.01),
    ),
  };
}

export function normalizeDecayMetadata(
  memoryKind: string,
  raw: Partial<MemoryDecayConfig> | null | undefined,
  policy = DEFAULT_MEMORY_POLICY,
): MemoryDecayConfig {
  const base = defaultDecayForKind(memoryKind, policy);
  const contextThreshold = clampNumber(raw?.contextThreshold, base.contextThreshold, 0.25, 0.75);
  return {
    curve: raw?.curve && isDecayCurve(raw.curve) ? raw.curve : base.curve,
    graceDays: clampInteger(raw?.graceDays, base.graceDays, 0, 180),
    halfLifeDays: clampInteger(raw?.halfLifeDays, base.halfLifeDays, 1, 365),
    pressureSensitivity: clampNumber(raw?.pressureSensitivity, base.pressureSensitivity, 0, 1),
    contextThreshold,
    archiveThreshold: Math.min(
      clampNumber(raw?.archiveThreshold, base.archiveThreshold, 0.05, 0.35),
      Math.max(0.01, contextThreshold - 0.01),
    ),
  };
}

function freshnessForMemory(memory: MemoryCard, now: Date, decay: MemoryDecayConfig): number {
  if (isExpired(memory, now)) {
    return 0;
  }
  if (memory.sectionId !== EVOLVING_MEMORY_SECTION_ID) {
    return 1;
  }

  const anchor = Date.parse(memory.lastConfirmedAt || memory.createdAt);
  if (!Number.isFinite(anchor)) {
    return 1;
  }
  const ageDays = Math.max(0, (now.getTime() - anchor) / 86_400_000);
  const activeDays = Math.max(0, ageDays - decay.graceDays);
  if (activeDays <= 0) {
    return 1;
  }

  if (decay.curve === "stable") {
    return clamp(Math.pow(0.5, activeDays / Math.max(1, decay.halfLifeDays * 4)), 0, 1);
  }
  if (decay.curve === "linear") {
    return clamp(1 - (activeDays / Math.max(1, decay.halfLifeDays * 2)), 0, 1);
  }
  return clamp(Math.pow(0.5, activeDays / Math.max(1, decay.halfLifeDays)), 0, 1);
}

function urgencyForMemory(memory: MemoryCard, now: Date): number {
  if (memory.sectionId !== TIME_BASED_SECTION_ID) {
    return 1;
  }
  const anchor = Date.parse(memory.eventAt ?? memory.expiresAt ?? "");
  if (!Number.isFinite(anchor)) {
    return 1;
  }
  const daysLeft = Math.max(0, (anchor - now.getTime()) / 86_400_000);
  if (daysLeft <= 1) return 1.2;
  if (daysLeft <= 7) return 1.1;
  return 1;
}

function pressureFactorForMemory(
  memory: MemoryCard,
  policy: MemoryPolicy,
  activeSectionCount: number | undefined,
): number {
  if (memory.sectionId !== EVOLVING_MEMORY_SECTION_ID || !activeSectionCount) {
    return 1;
  }
  const sectionPolicy = policy.sections.evolvingMemory;
  const usageRatio = activeSectionCount / sectionPolicy.maxLiveCards;
  if (usageRatio <= sectionPolicy.pressureStartsAtRatio) {
    return 1;
  }
  const pressureRange = Math.max(0.01, 1 - sectionPolicy.pressureStartsAtRatio);
  const pressure = clamp((usageRatio - sectionPolicy.pressureStartsAtRatio) / pressureRange, 0, 1);
  const decay = getMemoryDecayConfig(memory, policy);
  return clamp(1 - pressure * decay.pressureSensitivity * (1 - memory.importance), 0, 1);
}

function defaultDecayForMemory(memory: MemoryCard, policy: MemoryPolicy): MemoryDecayConfig {
  if (memory.sectionId !== EVOLVING_MEMORY_SECTION_ID) {
    return {
      ...policy.sections.evolvingMemory.decay.stable,
      contextThreshold: policy.sections.evolvingMemory.defaultContextThreshold,
      archiveThreshold: policy.sections.evolvingMemory.defaultArchiveThreshold,
    };
  }
  return defaultDecayForKind(memory.kind, policy);
}

function defaultDecayForKind(kind: string, policy: MemoryPolicy): MemoryDecayConfig {
  const normalized = kind.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (normalized === "procedural" || normalized === "constraint" || normalized === "permission") {
    return policy.sections.evolvingMemory.decay.stable;
  }
  if (normalized === "current_project") {
    return policy.sections.evolvingMemory.decay.delayedDrop;
  }
  if (normalized === "feedback" || normalized === "routine" || normalized === "goal") {
    return policy.sections.evolvingMemory.decay.exponential;
  }
  if (normalized === "temporary" || normalized === "short_lived") {
    return policy.sections.evolvingMemory.decay.superFast;
  }
  return policy.sections.evolvingMemory.decay.linear;
}

function readDecayMetadata(memory: MemoryCard): Record<string, unknown> | null {
  if (!memory.metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(memory.metadataJson) as Record<string, unknown>;
    const decay = parsed["decay"];
    return decay && typeof decay === "object" && !Array.isArray(decay) ? decay as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isDecayCurve(value: unknown): value is MemoryDecayConfig["curve"] {
  return value === "stable" ||
    value === "linear" ||
    value === "exponential" ||
    value === "delayed_drop" ||
    value === "super_fast";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return clamp(value, min, max);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.floor(clampNumber(value, fallback, min, max));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
