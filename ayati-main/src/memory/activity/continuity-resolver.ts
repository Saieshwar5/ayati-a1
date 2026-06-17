import { deterministicScore, hasExplicitNewTaskSignal, isFollowUpMessage } from "./policy.js";
import {
  extractMessageIdentities,
  normalizeIdentityValue,
} from "./activity-store.js";
import type { ActivityStore } from "./activity-store.js";
import type {
  ActivityAssetRef,
  ActivityCandidate,
  ActivityContext,
  ActivityIdentity,
  ActivityResolutionInput,
  ActivityThread,
  ContinuityContext,
} from "./types.js";

export interface ContinuityResolverOptions {
  store: ActivityStore;
  now?: () => Date;
}

export class ContinuityResolver {
  private readonly store: ActivityStore;
  private readonly nowProvider: () => Date;

  constructor(options: ContinuityResolverOptions) {
    this.store = options.store;
    this.nowProvider = options.now ?? (() => new Date());
  }

  resolve(input: ActivityResolutionInput): ContinuityContext {
    const message = input.userMessage.trim();
    if (!message) {
      return { mode: "new", confidence: 0, reasons: ["empty input"] };
    }
    if (hasExplicitNewTaskSignal(message)) {
      return { mode: "new", confidence: 0.92, reasons: ["user signaled new or unrelated work"] };
    }

    const nowIso = this.nowProvider().toISOString();
    const identities = dedupeIdentities([
      ...(input.identities ?? []),
      ...extractMessageIdentities(message, nowIso),
      ...assetIdentities(input.currentAssetRefs ?? [], nowIso),
    ]);
    const identityMatches = identities.length > 0
      ? this.store.findByIdentities(input.clientId, identities, 5)
      : [];
    const followUp = isFollowUpMessage(message);
    const textMatches = this.store.search(input.clientId, message, { limit: 5 });
    const recent = this.store.listRecent(input.clientId, 3);
    const scored = scoreActivities({
      activities: mergeActivities([
        ...identityMatches.map((match) => match.activity),
        ...textMatches,
        ...(followUp ? recent.slice(0, 1) : []),
      ]),
      identityMatches,
      message,
      identities,
      followUp,
      now: this.nowProvider(),
    });

    if (scored.length === 0) {
      return { mode: "new", confidence: 0.86, reasons: ["no matching activity anchors or candidates"] };
    }

    const [top, second] = scored;
    if (!top) {
      return { mode: "new", confidence: 0.86, reasons: ["no matching activity anchors or candidates"] };
    }

    if (top.score >= 0.82 && (!second || top.score - second.score >= 0.12)) {
      return {
        mode: "continue",
        confidence: top.score,
        reasons: [top.reason],
        current: toActivityContext(top.activity),
      };
    }

    if (followUp && top.score >= 0.72 && (!second || top.score - second.score >= 0.18)) {
      return {
        mode: "continue",
        confidence: top.score,
        reasons: [top.reason, "current message is follow-up phrasing"],
        current: toActivityContext(top.activity),
      };
    }

    if (top.score >= 0.4) {
      return {
        mode: "ambiguous",
        confidence: top.score,
        reasons: [
          second ? "multiple possible activity matches are close" : "best activity match is below auto-continue threshold",
        ],
        candidates: scored.slice(0, 3).map(({ activity, score, reason }) => toCandidate(activity, score, reason)),
      };
    }

    return {
      mode: "new",
      confidence: 0.78,
      reasons: ["candidate scores were too weak for reliable continuation"],
    };
  }
}

export function toActivityContext(activity: ActivityThread): ActivityContext {
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    title: activity.title,
    ...(activity.state.goal ? { goal: activity.state.goal } : {}),
    openWork: activity.state.openWork.slice(0, 5),
    ...(activity.state.nextStep ? { nextStep: activity.state.nextStep } : {}),
    verifiedFacts: activity.state.verifiedFacts.slice(-6),
    topAssets: topAssetLabels(activity),
    lastTouchedAt: activity.lastTouchedAt,
  };
}

function scoreActivities(input: {
  activities: ActivityThread[];
  identityMatches: Array<{ activity: ActivityThread; matches: number }>;
  message: string;
  identities: Array<Pick<ActivityIdentity, "type" | "value">>;
  followUp: boolean;
  now: Date;
}): Array<{ activity: ActivityThread; score: number; reason: string }> {
  const terms = tokenize(input.message);
  return input.activities
    .map((activity) => {
      const identityMatchCount = input.identityMatches.find((match) => match.activity.activityId === activity.activityId)?.matches ?? 0;
      const aliasMatches = countAliasMatches(activity, input.message);
      const textScore = tokenOverlapScore(terms, searchableActivityText(activity));
      const recencyScore = recencyScoreFor(activity, input.now);
      const hasDurableAnchor = input.identities.length > 0 || activity.identities.length > 0 || activity.assets.length > 0;
      const score = deterministicScore({
        identityMatches: identityMatchCount,
        aliasMatches,
        textScore,
        recencyScore,
        followUp: input.followUp,
        hasDurableAnchor,
      });
      return {
        activity,
        score,
        reason: reasonFor({ identityMatchCount, aliasMatches, textScore, recencyScore, followUp: input.followUp }),
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.activity.lastTouchedAt.localeCompare(a.activity.lastTouchedAt));
}

function reasonFor(input: {
  identityMatchCount: number;
  aliasMatches: number;
  textScore: number;
  recencyScore: number;
  followUp: boolean;
}): string {
  if (input.identityMatchCount > 0) return `matched ${input.identityMatchCount} durable activity identity anchor(s)`;
  if (input.aliasMatches > 0) return `matched ${input.aliasMatches} activity alias(es)`;
  if (input.followUp && input.recencyScore > 0) return "follow-up phrasing matched the latest recent activity";
  return `matched activity search terms (${Math.round(input.textScore * 100)}%)`;
}

function toCandidate(activity: ActivityThread, score: number, reason: string): ActivityCandidate {
  return {
    activityId: activity.activityId,
    kind: activity.kind,
    title: activity.title,
    reason,
    score,
    topAssets: topAssetLabels(activity),
    lastTouchedAt: activity.lastTouchedAt,
  };
}

function topAssetLabels(activity: ActivityThread): string[] {
  return activity.assets
    .map((asset) => asset.path ?? asset.displayName ?? asset.documentId ?? asset.fileId ?? asset.directoryId ?? asset.uri ?? "")
    .filter(Boolean)
    .slice(0, 5);
}

function assetIdentities(assets: ActivityAssetRef[], at: string): ActivityIdentity[] {
  return dedupeIdentities(assets.flatMap((asset) => [
    identity("asset_id", asset.assetId, at),
    identity("prepared_input_id", asset.preparedInputId, at),
    identity("document_id", asset.documentId, at),
    identity(asset.kind === "dataset" ? "dataset_id" : "document_id", asset.summary?.documentId, at),
    identity("file_id", asset.fileId, at),
    identity("directory_id", asset.directoryId, at),
    identity("file_path", asset.path, at),
    identity("file_path", asset.restore?.filePath, at),
    identity("directory_path", asset.restore?.directoryPath, at),
    identity("directory_path", asset.kind === "directory" ? asset.path : undefined, at),
    identity("explicit_alias", asset.displayName, at),
  ].filter((item): item is ActivityIdentity => item !== null)));
}

function identity(type: ActivityIdentity["type"], value: string | undefined, at: string): ActivityIdentity | null {
  const normalized = normalizeIdentityValue(type, value);
  if (!normalized) return null;
  return {
    type,
    value: normalized,
    confidence: 0.88,
    source: "asset",
    lastSeenAt: at,
  };
}

function dedupeIdentities<T extends Pick<ActivityIdentity, "type" | "value">>(identities: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const identity of identities) {
    const normalized = normalizeIdentityValue(identity.type, identity.value);
    if (!normalized) continue;
    const key = `${identity.type}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...identity, value: normalized });
  }
  return output;
}

function mergeActivities(activities: ActivityThread[]): ActivityThread[] {
  const seen = new Set<string>();
  const output: ActivityThread[] = [];
  for (const activity of activities) {
    if (seen.has(activity.activityId)) continue;
    seen.add(activity.activityId);
    output.push(activity);
  }
  return output;
}

function countAliasMatches(activity: ActivityThread, message: string): number {
  const normalized = message.toLowerCase();
  return activity.aliases.filter((alias) => normalized.includes(alias.value)).length;
}

function recencyScoreFor(activity: ActivityThread, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(activity.lastTouchedAt)) / 86_400_000);
  if (ageDays <= 1) return 0.1;
  if (ageDays <= 7) return 0.06;
  if (ageDays <= 30) return 0.03;
  return 0;
}

function searchableActivityText(activity: ActivityThread): string {
  return [
    activity.title,
    activity.summary,
    activity.kind,
    activity.state.goal,
    activity.state.nextStep,
    ...activity.state.openWork,
    ...activity.state.verifiedFacts,
    ...activity.state.changedFiles,
    ...activity.state.workingDirectories,
    ...activity.aliases.map((alias) => alias.value),
    ...activity.assets.flatMap((asset) => [
      asset.displayName,
      asset.path,
      asset.documentId,
      asset.fileId,
      asset.directoryId,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function tokenOverlapScore(terms: string[], haystack: string): number {
  const unique = [...new Set(terms)];
  if (unique.length === 0) return 0;
  return unique.filter((term) => haystack.includes(term)).length / unique.length;
}

function tokenize(value: string): string[] {
  return value.toLowerCase()
    .split(/[^a-z0-9_.\/-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 24);
}
