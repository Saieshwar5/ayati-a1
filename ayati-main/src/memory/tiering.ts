import type { SessionTier } from "./session-events.js";

export interface SessionTierConfig {
  hardCapMinutes: number;
  idleTimeoutMinutes: number;
}

export const TIER_CONFIG: Record<SessionTier, SessionTierConfig> = {
  high: { hardCapMinutes: 3 * 60, idleTimeoutMinutes: 20 },
  medium: { hardCapMinutes: 6 * 60, idleTimeoutMinutes: 45 },
  low: { hardCapMinutes: 12 * 60, idleTimeoutMinutes: 90 },
  rare: { hardCapMinutes: 24 * 60, idleTimeoutMinutes: 180 },
};

export const HYSTERESIS_REQUIRED_HITS = 2;

export interface TierState {
  tier: SessionTier;
  hardCapMinutes: number;
  idleTimeoutMinutes: number;
  candidateTier: SessionTier | null;
  candidateHits: number;
}

export function scoreToTier(score: number): SessionTier {
  if (score >= 40) return "high";
  if (score >= 20) return "medium";
  if (score >= 8) return "low";
  return "rare";
}

export function createInitialTierState(tier: SessionTier): TierState {
  const cfg = TIER_CONFIG[tier];
  return {
    tier,
    hardCapMinutes: cfg.hardCapMinutes,
    idleTimeoutMinutes: cfg.idleTimeoutMinutes,
    candidateTier: null,
    candidateHits: 0,
  };
}

export interface ShouldCloseInput {
  startedAt: string;
  lastActivityAt: string;
  hardCapMinutes: number;
  idleTimeoutMinutes: number;
}

export function shouldCloseSession(input: ShouldCloseInput, nowIso: string): boolean {
  const idleMinutes = minutesBetween(input.lastActivityAt, nowIso);
  if (idleMinutes >= input.idleTimeoutMinutes) return true;

  const ageMinutes = minutesBetween(input.startedAt, nowIso);
  if (ageMinutes >= input.hardCapMinutes) return true;

  return false;
}

export interface RefreshResult {
  changed: boolean;
  newState: TierState;
}

export function refreshTier(current: TierState, score: number): RefreshResult {
  const desiredTier = scoreToTier(score);

  if (desiredTier === current.tier) {
    return {
      changed: false,
      newState: { ...current, candidateTier: null, candidateHits: 0 },
    };
  }

  const nextHits = current.candidateTier === desiredTier ? current.candidateHits + 1 : 1;

  if (nextHits < HYSTERESIS_REQUIRED_HITS) {
    return {
      changed: false,
      newState: { ...current, candidateTier: desiredTier, candidateHits: nextHits },
    };
  }

  const cfg = TIER_CONFIG[desiredTier];
  return {
    changed: true,
    newState: {
      tier: desiredTier,
      hardCapMinutes: cfg.hardCapMinutes,
      idleTimeoutMinutes: cfg.idleTimeoutMinutes,
      candidateTier: null,
      candidateHits: 0,
    },
  };
}

export interface TimelineEntry {
  type: string;
  ts: string;
  tokenEstimate?: number;
}

export function computeActivityScoreFromTimeline(timeline: TimelineEntry[], nowIso: string): number {
  const oneHourAgoMs = parseDate(nowIso).getTime() - 60 * 60 * 1000;

  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  let tokenSum = 0;

  for (const entry of timeline) {
    if (parseDate(entry.ts).getTime() < oneHourAgoMs) continue;

    if (entry.type === "user_message") {
      userCount++;
      tokenSum += entry.tokenEstimate ?? 0;
    } else if (entry.type === "assistant_message") {
      assistantCount++;
      tokenSum += entry.tokenEstimate ?? 0;
    } else if (entry.type === "tool_call") {
      toolCount++;
    }
  }

  return 3 * userCount + 2 * assistantCount + 4 * toolCount + tokenSum / 1500;
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date(0);
  return parsed;
}

function minutesBetween(fromIso: string, toIso: string): number {
  const deltaMs = parseDate(toIso).getTime() - parseDate(fromIso).getTime();
  return deltaMs / (60 * 1000);
}
