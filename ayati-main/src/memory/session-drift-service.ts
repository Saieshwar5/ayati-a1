import type { LlmMessage } from "../core/contracts/llm-protocol.js";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { ConversationTurn, SessionProfile, SessionProfileMetadata, TopicDriftDecision } from "./types.js";
import { devWarn } from "../shared/index.js";

const MAX_TURNS_IN_PROMPT = 12;
const MAX_LIST_ITEMS = 12;

interface ProfilePayload {
  title: string;
  scope: string;
  keywords: string[];
  anchors: string[];
  subtopics?: string[];
  active_goals?: string[];
  constraints?: string[];
  stable_entities?: string[];
  decision_log?: string[];
  open_loops?: string[];
  topic_confidence?: number;
}

interface DriftPayload {
  is_drift: boolean;
  confidence: number;
  reason: string;
  updated_profile?: ProfilePayload;
}

const EMPTY_METADATA: SessionProfileMetadata = {
  subtopics: [],
  activeGoals: [],
  constraints: [],
  stableEntities: [],
  decisionLog: [],
  openLoops: [],
};

function parseJson<T>(text: string): T | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

function normalizeList(items: string[] | undefined, max: number): string[] {
  if (!items || items.length === 0) return [];
  const unique = new Set<string>();
  for (const item of items) {
    const cleaned = item
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._/-\s]/g, "")
      .replace(/\s+/g, " ");
    if (cleaned.length < 2) continue;
    unique.add(cleaned);
    if (unique.size >= max) break;
  }
  return [...unique];
}

function clampConfidence(value: number | undefined, fallback: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, candidate));
}

function buildMetadata(payload: ProfilePayload): SessionProfileMetadata {
  return {
    subtopics: normalizeList(payload.subtopics, 12),
    activeGoals: normalizeList(payload.active_goals, 12),
    constraints: normalizeList(payload.constraints, 12),
    stableEntities: normalizeList(payload.stable_entities, 16),
    decisionLog: normalizeList(payload.decision_log, 16),
    openLoops: normalizeList(payload.open_loops, 16),
  };
}

function toProfile(payload: ProfilePayload, version: number, nowIso: string): SessionProfile {
  return {
    title: payload.title.trim().slice(0, 120),
    scope: payload.scope.trim().slice(0, 280),
    keywords: normalizeList(payload.keywords, MAX_LIST_ITEMS),
    anchors: normalizeList(payload.anchors, 10),
    ...buildMetadata(payload),
    topicConfidence: clampConfidence(payload.topic_confidence, 0.7),
    updatedAt: nowIso,
    version,
  };
}

function detectDriftFallback(profile: SessionProfile, recentTurns: ConversationTurn[]): TopicDriftDecision {
  const latestUser = [...recentTurns].reverse().find((turn) => turn.role === "user");
  if (!latestUser) {
    return { isDrift: false, confidence: 0.4, reason: "no recent user turn" };
  }

  const messageTokens = normalizeList(latestUser.content.split(/\s+/), 64);
  if (messageTokens.length < 5) {
    return { isDrift: false, confidence: 0.5, reason: "short acknowledgement" };
  }

  const explicitSwitchPhrases = [
    "new topic",
    "different question",
    "unrelated",
    "another thing",
    "separate issue",
    "switch topic",
  ];
  const lowered = latestUser.content.toLowerCase();
  if (explicitSwitchPhrases.some((phrase) => lowered.includes(phrase))) {
    return { isDrift: true, confidence: 0.9, reason: "explicit topic switch phrase" };
  }

  const keywordSet = new Set(profile.keywords);
  const anchorSet = new Set(profile.anchors);
  let keywordHits = 0;
  let anchorHits = 0;
  for (const token of messageTokens) {
    if (keywordSet.has(token)) keywordHits++;
    if (anchorSet.has(token)) anchorHits++;
  }

  const keywordOverlap = keywordSet.size > 0 ? keywordHits / keywordSet.size : 0;
  const anchorOverlap = anchorSet.size > 0 ? anchorHits / anchorSet.size : 0;
  const isDrift = keywordOverlap < 0.18 && anchorOverlap < 0.1;

  return {
    isDrift,
    confidence: isDrift ? 0.7 : 0.65,
    reason: isDrift ? "low keyword/anchor overlap" : "sufficient overlap with active session profile",
  };
}

export interface CheckpointEvaluationResult {
  decision: TopicDriftDecision;
  updatedProfile: SessionProfile | null;
}

export interface SessionDriftServiceOptions {
  provider?: LlmProvider;
}

export class SessionDriftService {
  private readonly provider?: LlmProvider;

  constructor(options?: SessionDriftServiceOptions) {
    this.provider = options?.provider;
  }

  async buildSessionProfile(turns: ConversationTurn[], nowIso: string): Promise<SessionProfile | null> {
    const llmProfile = this.provider ? await this.tryBuildProfileWithLlm(turns, nowIso) : null;
    if (llmProfile) return llmProfile;

    const userTurns = turns.filter((turn) => turn.role === "user");
    if (userTurns.length === 0) return null;

    const keywords = normalizeList(
      userTurns.flatMap((turn) => turn.content.split(/\s+/)),
      MAX_LIST_ITEMS,
    );
    const fallbackTitle = userTurns[userTurns.length - 1]!.content.slice(0, 60) || "active session";

    return {
      title: fallbackTitle,
      scope: "Conversation on a single active topic",
      keywords,
      anchors: keywords.slice(0, 6),
      ...EMPTY_METADATA,
      topicConfidence: 0.5,
      updatedAt: nowIso,
      version: 1,
    };
  }

  async evaluateCheckpoint(
    profile: SessionProfile,
    recentTurns: ConversationTurn[],
    nowIso: string,
  ): Promise<CheckpointEvaluationResult> {
    const llmResult = this.provider
      ? await this.tryEvaluateWithLlm(profile, recentTurns, nowIso)
      : null;

    if (llmResult) return llmResult;

    return {
      decision: detectDriftFallback(profile, recentTurns),
      updatedProfile: {
        ...profile,
        updatedAt: nowIso,
        version: profile.version + 1,
      },
    };
  }

  private async tryBuildProfileWithLlm(
    turns: ConversationTurn[],
    nowIso: string,
  ): Promise<SessionProfile | null> {
    try {
      const compact = turns.slice(-MAX_TURNS_IN_PROMPT);
      const messages: LlmMessage[] = [
        {
          role: "system",
          content: [
            "You build a compact profile for an active chat session topic.",
            "Output strict JSON only.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "Create JSON:",
            `{"title":"...","scope":"...","keywords":["..."],"anchors":["..."],"subtopics":["..."],"active_goals":["..."],"constraints":["..."],"stable_entities":["..."],"decision_log":["..."],"open_loops":["..."],"topic_confidence":0.0}`,
            "Limits: title <= 12 words, scope <= 240 chars, lists <= 12 items, lowercase keywords/anchors.",
            "Conversation turns:",
            JSON.stringify(compact),
          ].join("\n"),
        },
      ];

      const output = await this.provider!.generateTurn({ messages });
      if (output.type !== "assistant") return null;

      const parsed = parseJson<ProfilePayload>(output.content);
      if (!parsed || typeof parsed.title !== "string" || typeof parsed.scope !== "string") return null;
      if (!Array.isArray(parsed.keywords) || !Array.isArray(parsed.anchors)) return null;

      return toProfile(parsed, 1, nowIso);
    } catch (err) {
      devWarn(
        "Session profile bootstrap LLM call failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async tryEvaluateWithLlm(
    profile: SessionProfile,
    recentTurns: ConversationTurn[],
    nowIso: string,
  ): Promise<CheckpointEvaluationResult | null> {
    try {
      const compact = recentTurns.slice(-MAX_TURNS_IN_PROMPT);
      const messages: LlmMessage[] = [
        {
          role: "system",
          content: [
            "You evaluate whether recent conversation drifted away from an active session topic.",
            "Return strict JSON only.",
          ].join(" "),
        },
        {
          role: "user",
          content: [
            "Given active session profile and recent turns, return:",
            `{"is_drift":false,"confidence":0.0,"reason":"...","updated_profile":{"title":"...","scope":"...","keywords":["..."],"anchors":["..."],"subtopics":["..."],"active_goals":["..."],"constraints":["..."],"stable_entities":["..."],"decision_log":["..."],"open_loops":["..."],"topic_confidence":0.0}}`,
            "If same topic, enrich updated_profile with new related metadata.",
            "If drift, updated_profile may be omitted.",
            "Active profile:",
            JSON.stringify(profile),
            "Recent turns:",
            JSON.stringify(compact),
          ].join("\n"),
        },
      ];

      const output = await this.provider!.generateTurn({ messages });
      if (output.type !== "assistant") return null;

      const parsed = parseJson<DriftPayload>(output.content);
      if (!parsed) return null;
      if (typeof parsed.is_drift !== "boolean" || typeof parsed.confidence !== "number") return null;
      if (typeof parsed.reason !== "string") return null;

      let updatedProfile: SessionProfile | null = null;
      if (parsed.updated_profile && !parsed.is_drift) {
        const candidate = parsed.updated_profile;
        if (
          typeof candidate.title === "string" &&
          typeof candidate.scope === "string" &&
          Array.isArray(candidate.keywords) &&
          Array.isArray(candidate.anchors)
        ) {
          updatedProfile = toProfile(candidate, profile.version + 1, nowIso);
        }
      }

      return {
        decision: {
          isDrift: parsed.is_drift,
          confidence: clampConfidence(parsed.confidence, 0.7),
          reason: parsed.reason.trim().slice(0, 240),
        },
        updatedProfile,
      };
    } catch (err) {
      devWarn(
        "Session drift checkpoint LLM call failed:",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}
