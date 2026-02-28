import type { ConversationTurn } from "../memory/types.js";
import { buildAutoRotateHandoff } from "./context-pressure.js";

export interface RotationPolicyConfig {
  forceRotateContextPercent: number;
  topicShiftReadyContextPercent: number;
  smallTalkMaxChars: number;
  topicShiftMinCurrentTokens: number;
  topicShiftMinOverlapRatio: number;
  topicHistoryUserTurns: number;
  topicVocabularyMaxTokens: number;
  midnightActiveGraceMinutes: number;
  midnightMaxDeferralMinutes: number;
}

export interface PendingMidnightRollover {
  fromDayKey: string;
  toDayKey: string;
  firstDetectedAtMs: number;
}

export type RotationReason =
  | "context_overflow"
  | "midnight_rollover"
  | "midnight_rollover_deferred_limit"
  | "topic_shift";

export interface EvaluateSessionRotationInput {
  now: Date;
  userMessage: string;
  contextPercent: number;
  turns: ConversationTurn[];
  previousSessionSummary: string;
  pendingMidnight?: PendingMidnightRollover | null;
  config?: Partial<RotationPolicyConfig>;
}

export interface EvaluateSessionRotationResult {
  rotate: boolean;
  reason?: RotationReason;
  handoffSummary?: string;
  pendingMidnight: PendingMidnightRollover | null;
}

export const DEFAULT_ROTATION_POLICY_CONFIG: RotationPolicyConfig = {
  forceRotateContextPercent: 95,
  topicShiftReadyContextPercent: 25,
  smallTalkMaxChars: 60,
  topicShiftMinCurrentTokens: 2,
  topicShiftMinOverlapRatio: 0.2,
  topicHistoryUserTurns: 12,
  topicVocabularyMaxTokens: 64,
  midnightActiveGraceMinutes: 10,
  midnightMaxDeferralMinutes: 60,
};

const STOPWORDS = new Set<string>([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "to",
  "us",
  "we",
  "what",
  "when",
  "where",
  "who",
  "why",
  "with",
  "you",
  "your",
]);

export function evaluateSessionRotation(input: EvaluateSessionRotationInput): EvaluateSessionRotationResult {
  const cfg = { ...DEFAULT_ROTATION_POLICY_CONFIG, ...(input.config ?? {}) };

  if (input.contextPercent >= cfg.forceRotateContextPercent) {
    return {
      rotate: true,
      reason: "context_overflow",
      handoffSummary: buildAutoRotateHandoff(
        input.turns,
        input.contextPercent,
        input.previousSessionSummary,
      ),
      pendingMidnight: null,
    };
  }

  const midnightDecision = evaluateMidnightRollover(input, cfg);
  if (midnightDecision.rotate) {
    return midnightDecision;
  }

  if (
    input.contextPercent >= cfg.topicShiftReadyContextPercent &&
    !isSmallTalkMessage(input.userMessage, cfg.smallTalkMaxChars) &&
    isLikelyTopicShift(input.userMessage, input.turns, cfg)
  ) {
    return {
      rotate: true,
      reason: "topic_shift",
      handoffSummary: buildRotationHandoff(
        input.turns,
        input.previousSessionSummary,
        `Session rotated due to topic shift at ${Math.round(input.contextPercent)}% context usage.`,
      ),
      pendingMidnight: midnightDecision.pendingMidnight,
    };
  }

  return {
    rotate: false,
    pendingMidnight: midnightDecision.pendingMidnight,
  };
}

export function isSmallTalkMessage(message: string, maxChars = DEFAULT_ROTATION_POLICY_CONFIG.smallTalkMaxChars): boolean {
  const text = normalizeForMatch(message);
  if (text.length === 0) return true;

  if (text.length <= maxChars) {
    if (SMALL_TALK_EXACT.has(text)) return true;
    if (SMALL_TALK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length <= 3 && words.every((w) => SMALL_TALK_WORDS.has(w))) {
    return true;
  }

  return false;
}

export function isLikelyTopicShift(
  userMessage: string,
  turns: ConversationTurn[],
  config: RotationPolicyConfig = DEFAULT_ROTATION_POLICY_CONFIG,
): boolean {
  const currentTokens = tokenizeTopicText(userMessage);
  if (currentTokens.length < config.topicShiftMinCurrentTokens) {
    return false;
  }

  const userTurns = turns.filter((turn) => turn.role === "user");
  const recentUserTurns = userTurns.slice(-config.topicHistoryUserTurns);

  const topicVocabulary = new Set<string>();
  for (const turn of recentUserTurns) {
    if (isSmallTalkMessage(turn.content, config.smallTalkMaxChars)) continue;
    const tokens = tokenizeTopicText(turn.content);
    for (const token of tokens) {
      topicVocabulary.add(token);
      if (topicVocabulary.size >= config.topicVocabularyMaxTokens) break;
    }
    if (topicVocabulary.size >= config.topicVocabularyMaxTokens) break;
  }

  if (topicVocabulary.size === 0) {
    return false;
  }

  let overlap = 0;
  for (const token of currentTokens) {
    if (topicVocabulary.has(token)) {
      overlap++;
    }
  }

  const overlapRatio = overlap / currentTokens.length;
  return overlapRatio < config.topicShiftMinOverlapRatio;
}

function evaluateMidnightRollover(
  input: EvaluateSessionRotationInput,
  cfg: RotationPolicyConfig,
): EvaluateSessionRotationResult {
  const now = input.now;
  const nowMs = now.getTime();
  const nowDayKey = toLocalDayKey(now);
  const pending = input.pendingMidnight ?? null;
  const lastTurn = getLastTurnDate(input.turns);
  if (!lastTurn) {
    return { rotate: false, pendingMidnight: null };
  }

  if (pending && pending.toDayKey === nowDayKey) {
    const lastTurnMs = lastTurn.getTime();
    const isActive = nowMs - lastTurnMs <= cfg.midnightActiveGraceMinutes * 60_000;
    if (!isActive) {
      return {
        rotate: true,
        reason: "midnight_rollover",
        handoffSummary: buildRotationHandoff(
          input.turns,
          input.previousSessionSummary,
          "Session rotated for daily midnight rollover.",
        ),
        pendingMidnight: null,
      };
    }

    const deferredMs = nowMs - pending.firstDetectedAtMs;
    if (deferredMs >= cfg.midnightMaxDeferralMinutes * 60_000) {
      return {
        rotate: true,
        reason: "midnight_rollover_deferred_limit",
        handoffSummary: buildRotationHandoff(
          input.turns,
          input.previousSessionSummary,
          "Session rotated after midnight deferral limit was reached during active conversation.",
        ),
        pendingMidnight: null,
      };
    }

    return {
      rotate: false,
      pendingMidnight: pending,
    };
  }

  const fromDayKey = toLocalDayKey(lastTurn);
  if (fromDayKey === nowDayKey) {
    return { rotate: false, pendingMidnight: null };
  }

  const lastTurnMs = lastTurn.getTime();
  const isActive = nowMs - lastTurnMs <= cfg.midnightActiveGraceMinutes * 60_000;
  if (!isActive) {
    return {
      rotate: true,
      reason: "midnight_rollover",
      handoffSummary: buildRotationHandoff(
        input.turns,
        input.previousSessionSummary,
        "Session rotated for daily midnight rollover.",
      ),
      pendingMidnight: null,
    };
  }

  const nextPending =
    pending && pending.fromDayKey === fromDayKey && pending.toDayKey === nowDayKey
      ? pending
      : {
          fromDayKey,
          toDayKey: nowDayKey,
          firstDetectedAtMs: nowMs,
        };

  return {
    rotate: false,
    pendingMidnight: nextPending,
  };
}

function buildRotationHandoff(
  turns: ConversationTurn[],
  previousSummary: string,
  headline: string,
): string {
  const recent = turns.slice(-6);
  const turnLines = recent.map((turn) => {
    const text = turn.content.length > 200 ? `${turn.content.slice(0, 200)}...` : turn.content;
    return `[${turn.role}]: ${text}`;
  });

  const parts = [headline, "", "Last conversation:", ...turnLines];
  if (previousSummary.trim().length > 0) {
    parts.push("", `Previous session summary: ${previousSummary.trim()}`);
  }

  return parts.join("\n").slice(0, 1000);
}

function getLastTurnDate(turns: ConversationTurn[]): Date | null {
  const last = turns[turns.length - 1];
  if (!last?.timestamp) return null;
  const parsed = new Date(last.timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function toLocalDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[!?.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeTopicText(value: string): string[] {
  return normalizeForMatch(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !STOPWORDS.has(token));
}

const SMALL_TALK_EXACT = new Set<string>([
  "hi",
  "hello",
  "hey",
  "yo",
  "thanks",
  "thank you",
  "thx",
  "ok",
  "okay",
  "cool",
  "great",
  "nice",
  "bye",
  "goodbye",
  "how are you",
  "how r u",
  "hru",
  "what's up",
  "whats up",
]);

const SMALL_TALK_WORDS = new Set<string>([
  "hi",
  "hello",
  "hey",
  "yo",
  "thanks",
  "thank",
  "you",
  "ok",
  "okay",
  "cool",
  "great",
  "bye",
]);

const SMALL_TALK_PATTERNS: RegExp[] = [
  /^(good )?(morning|afternoon|evening)$/,
  /^how( is|'s)? it going$/,
  /^are you there$/,
  /^see you( later)?$/,
];
