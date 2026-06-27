import { basename } from "node:path";
import type { DailySessionGitStore, TaskBranchInfo, TaskCommitLogEntry } from "./git-store.js";
import type { TaskAssetRecord, TaskFile, TaskStateFile } from "./task-files.js";
import type { GitRef } from "./refs.js";
import { parseWorkBranchRef } from "./refs.js";
import type { SessionId, WorkId } from "./ids.js";
import {
  deriveTitleFromMessage,
  includesNormalizedPhrase,
  normalizeText,
  tokenOverlap,
  tokenize,
} from "./text-match.js";

export interface DailySessionTaskResolverOptions {
  commitLogLimit?: number;
}

export interface ResolveTaskInput {
  sessionId: SessionId;
  userMessage: string;
}

export interface TaskResolutionCandidate {
  workId: WorkId;
  ref: GitRef;
  title: string;
  score: number;
  reasons: string[];
}

export type TaskResolution =
  | {
      mode: "continue_focus";
      workId: WorkId;
      ref: GitRef;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "switch_existing";
      workId: WorkId;
      ref: GitRef;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "create_new";
      title: string;
      objective: string;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "ambiguous";
      candidates: TaskResolutionCandidate[];
      reason: string;
    };

interface ResolverCandidate {
  branch: TaskBranchInfo;
  task: TaskFile | null;
  state: TaskStateFile | null;
  assets: TaskAssetRecord[];
  commits: TaskCommitLogEntry[];
}

const WORK_ID_PATTERN = /W-\d{8}-\d{4}/g;
const STRONG_MATCH_SCORE = 70;
const MEDIUM_MATCH_SCORE = 50;

export class DailySessionTaskResolver {
  private readonly commitLogLimit: number;

  constructor(
    private readonly store: DailySessionGitStore,
    options?: DailySessionTaskResolverOptions,
  ) {
    this.commitLogLimit = options?.commitLogLimit ?? 5;
  }

  async resolve(input: ResolveTaskInput): Promise<TaskResolution> {
    const userMessage = input.userMessage.trim();
    const [focusRef, branches] = await Promise.all([
      this.store.readFocus(input.sessionId),
      this.store.listTaskBranches(input.sessionId),
    ]);
    const focusWorkId = focusRef ? parseWorkBranchRef(focusRef)?.workId : undefined;
    const candidates = await this.loadCandidates(input.sessionId, branches);
    const explicitWorkIds = extractExplicitWorkIds(userMessage);
    if (explicitWorkIds.length > 0) {
      return this.resolveExplicitWorkId(explicitWorkIds, candidates, focusWorkId);
    }

    const focused = focusWorkId ? candidates.find((candidate) => candidate.branch.workId === focusWorkId) : undefined;
    if (isPureFollowUp(userMessage)) {
      if (focused) {
        return {
          mode: "continue_focus",
          workId: focused.branch.workId,
          ref: focused.branch.ref,
          confidence: "deterministic",
          reason: "follow-up phrase with active focus",
        };
      }
      return createNew(userMessage, "follow-up phrase had no active focus");
    }

    const scored = candidates
      .map((candidate) => scoreCandidate(userMessage, candidate))
      .filter((candidate) => candidate.score >= MEDIUM_MATCH_SCORE)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));

    const strong = scored.filter((candidate) => candidate.score >= STRONG_MATCH_SCORE);
    if (strong.length > 1) {
      return {
        mode: "ambiguous",
        candidates: strong,
        reason: "multiple existing tasks matched strongly",
      };
    }
    if (strong.length === 1) {
      const selected = strong[0]!;
      return selected.workId === focusWorkId
        ? {
            mode: "continue_focus",
            workId: selected.workId,
            ref: selected.ref,
            confidence: "deterministic",
            reason: selected.reasons[0] ?? "focused task matched",
          }
        : {
            mode: "switch_existing",
            workId: selected.workId,
            ref: selected.ref,
            confidence: "deterministic",
            reason: selected.reasons[0] ?? "existing task matched",
          };
    }

    if (scored.length > 1) {
      return {
        mode: "ambiguous",
        candidates: scored,
        reason: "multiple existing tasks matched partially",
      };
    }

    return createNew(userMessage, "no existing task matched deterministically");
  }

  private resolveExplicitWorkId(
    workIds: WorkId[],
    candidates: ResolverCandidate[],
    focusWorkId: WorkId | undefined,
  ): TaskResolution {
    const matched = workIds
      .map((workId) => candidates.find((candidate) => candidate.branch.workId === workId))
      .filter((candidate): candidate is ResolverCandidate => candidate !== undefined);
    if (workIds.length > 1 || matched.length > 1) {
      return {
        mode: "ambiguous",
        candidates: matched.map((candidate) => candidateToResolutionCandidate(candidate, 100, ["explicit work id matched"])),
        reason: "multiple explicit work ids were provided",
      };
    }
    const selected = matched[0];
    if (!selected) {
      return {
        mode: "ambiguous",
        candidates: [],
        reason: `explicit work id not found: ${workIds[0] ?? "unknown"}`,
      };
    }
    return selected.branch.workId === focusWorkId
      ? {
          mode: "continue_focus",
          workId: selected.branch.workId,
          ref: selected.branch.ref,
          confidence: "deterministic",
          reason: "explicit work id matched active focus",
        }
      : {
          mode: "switch_existing",
          workId: selected.branch.workId,
          ref: selected.branch.ref,
          confidence: "deterministic",
          reason: "explicit work id matched existing task",
        };
  }

  private async loadCandidates(sessionId: SessionId, branches: TaskBranchInfo[]): Promise<ResolverCandidate[]> {
    return await Promise.all(branches.map(async (branch) => ({
      branch,
      task: await this.store.readTaskFile(sessionId, branch.workId),
      state: await this.store.readTaskState(sessionId, branch.workId),
      assets: await this.store.readTaskAssets(sessionId, branch.workId),
      commits: await this.store.readTaskCommitLog(sessionId, branch.workId, this.commitLogLimit),
    })));
  }
}

function scoreCandidate(userMessage: string, candidate: ResolverCandidate): TaskResolutionCandidate {
  const reasons: string[] = [];
  let score = 0;
  const messageTokens = tokenize(userMessage);
  const title = candidate.task?.title ?? candidate.branch.slug;
  if (includesNormalizedPhrase(userMessage, title)) {
    score = Math.max(score, 90);
    reasons.push("task title matched");
  }
  if (includesNormalizedPhrase(userMessage, candidate.branch.slug.replace(/-/g, " "))) {
    score = Math.max(score, 85);
    reasons.push("branch slug matched");
  }
  if (candidate.task?.objective && includesNormalizedPhrase(userMessage, candidate.task.objective)) {
    score = Math.max(score, 75);
    reasons.push("task objective matched");
  }
  for (const item of candidate.state?.open ?? []) {
    if (includesNormalizedPhrase(userMessage, item)) {
      score = Math.max(score, 72);
      reasons.push("open work matched");
    }
  }
  for (const asset of candidate.assets) {
    const assetNames = [asset.name, asset.path, asset.path ? basename(asset.path) : undefined]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (assetNames.some((value) => includesNormalizedPhrase(userMessage, value))) {
      score = Math.max(score, 80);
      reasons.push("asset name matched");
    }
  }
  for (const commit of candidate.commits) {
    const subject = commit.message.split(/\r?\n/)[0] ?? "";
    if (subject && includesNormalizedPhrase(userMessage, subject)) {
      score = Math.max(score, 65);
      reasons.push("recent commit subject matched");
    }
  }
  const titleOverlap = tokenOverlap(messageTokens, tokenize(title));
  if (titleOverlap.length >= 2) {
    score = Math.max(score, 70);
    reasons.push(`task title tokens matched: ${titleOverlap.join(", ")}`);
  } else if (titleOverlap.length === 1) {
    score = Math.max(score, 55);
    reasons.push(`task title token matched: ${titleOverlap[0]}`);
  }
  const objectiveOverlap = tokenOverlap(messageTokens, tokenize(candidate.task?.objective ?? ""));
  if (objectiveOverlap.length >= 2) {
    score = Math.max(score, 60);
    reasons.push(`task objective tokens matched: ${objectiveOverlap.join(", ")}`);
  }
  return candidateToResolutionCandidate(candidate, score, reasons.length > 0 ? reasons : ["candidate matched"]);
}

function candidateToResolutionCandidate(
  candidate: ResolverCandidate,
  score: number,
  reasons: string[],
): TaskResolutionCandidate {
  return {
    workId: candidate.branch.workId,
    ref: candidate.branch.ref,
    title: candidate.task?.title ?? candidate.branch.slug,
    score,
    reasons,
  };
}

function extractExplicitWorkIds(message: string): WorkId[] {
  return [...new Set(normalizeText(message).toUpperCase().match(WORK_ID_PATTERN) ?? [])];
}

function isPureFollowUp(message: string): boolean {
  const normalized = normalizeText(message);
  return [
    "continue",
    "continue it",
    "do it",
    "do the rest",
    "finish",
    "finish it",
    "go ahead",
    "next",
    "ok",
    "okay",
    "resume",
    "yes",
  ].includes(normalized);
}

function createNew(userMessage: string, reason: string): TaskResolution {
  return {
    mode: "create_new",
    title: deriveTitleFromMessage(userMessage),
    objective: userMessage.trim() || "Untitled task",
    confidence: "deterministic",
    reason,
  };
}
