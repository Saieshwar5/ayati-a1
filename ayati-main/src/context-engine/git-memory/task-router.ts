import type {
  CreateGitMemoryTaskBranchResult,
  GitMemoryDailySessionStore,
  GitMemoryTaskRoutingSnapshotTask,
  SelectGitMemoryTaskForTurnResult,
} from "./session-store.js";
import { scoreGitMemoryTaskSearchDocument } from "./session-store.js";
import type {
  GitMemoryConversationSeqRange,
  GitMemoryRunId,
  GitMemorySessionId,
  GitMemoryTaskId,
} from "./schema.js";

export interface GitMemoryTaskRouterOptions {
  strongMatchScore?: number;
  mediumMatchScore?: number;
}

export interface ResolveGitMemoryTaskRouteInput {
  sessionId: GitMemorySessionId;
  userMessage: string;
}

export interface ApplyGitMemoryTaskRouteInput extends ResolveGitMemoryTaskRouteInput, GitMemoryConversationSeqRange {
  at?: string;
  runId?: GitMemoryRunId;
  sessionRunId?: GitMemoryRunId;
  title?: string;
  objective?: string;
}

export interface GitMemoryTaskRouteCandidate {
  taskId: GitMemoryTaskId;
  branch: string;
  ref: string;
  title: string;
  status: string;
  score: number;
  reasons: string[];
}

export type GitMemoryTaskRouteResolution =
  | {
      mode: "continue_active_task";
      taskId: GitMemoryTaskId;
      branch: string;
      ref: string;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "switch_to_existing_task";
      taskId: GitMemoryTaskId;
      branch: string;
      ref: string;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "reopen_existing_task";
      taskId: GitMemoryTaskId;
      branch: string;
      ref: string;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "create_new_task";
      title: string;
      objective: string;
      confidence: "deterministic";
      reason: string;
    }
  | {
      mode: "ambiguous";
      candidates: GitMemoryTaskRouteCandidate[];
      reason: string;
    };

export type AppliedGitMemoryTaskRoute =
  | {
      status: "ready";
      mode: Exclude<GitMemoryTaskRouteResolution["mode"], "ambiguous">;
      sessionId: GitMemorySessionId;
      taskId: GitMemoryTaskId;
      branch: string;
      ref: string;
      conversationRefs: GitMemoryConversationSeqRange[];
      confidence: "deterministic";
      reason: string;
      createdTask?: CreateGitMemoryTaskBranchResult;
      selectedTask?: SelectGitMemoryTaskForTurnResult;
    }
  | {
      status: "ambiguous";
      sessionId: GitMemorySessionId;
      candidates: GitMemoryTaskRouteCandidate[];
      reason: string;
    };

interface ScoredTaskCandidate extends GitMemoryTaskRouteCandidate {
  task: GitMemoryTaskRoutingSnapshotTask;
}

const TASK_ID_PATTERN = /W-\d{8}-\d{4}/g;
const DEFAULT_STRONG_MATCH_SCORE = 70;
const DEFAULT_MEDIUM_MATCH_SCORE = 50;

export class GitMemoryTaskRouter {
  private readonly strongMatchScore: number;
  private readonly mediumMatchScore: number;

  constructor(
    private readonly store: GitMemoryDailySessionStore,
    options?: GitMemoryTaskRouterOptions,
  ) {
    this.strongMatchScore = options?.strongMatchScore ?? DEFAULT_STRONG_MATCH_SCORE;
    this.mediumMatchScore = options?.mediumMatchScore ?? DEFAULT_MEDIUM_MATCH_SCORE;
  }

  async resolve(input: ResolveGitMemoryTaskRouteInput): Promise<GitMemoryTaskRouteResolution> {
    const userMessage = input.userMessage.trim();
    const snapshot = await this.store.readTaskRoutingSnapshot(input.sessionId);
    const candidates = snapshot.tasks.filter((task) => !task.missing);
    const focusTaskId = snapshot.focus?.activeTaskId ?? undefined;
    const explicitTaskIds = extractExplicitTaskIds(userMessage);
    if (explicitTaskIds.length > 0) {
      return resolveExplicitTaskId(explicitTaskIds, candidates, focusTaskId);
    }

    const focused = focusTaskId
      ? candidates.find((candidate) => candidate.taskId === focusTaskId)
      : undefined;
    if (isGitMemoryPureFollowUpMessage(userMessage)) {
      if (focused) {
        return selectedTaskResolution(focused, focusTaskId, isReopenStatus(focused.status)
          ? "follow-up phrase with completed active focus"
          : "follow-up phrase with active focus");
      }
      return createNew(userMessage, "follow-up phrase had no active focus");
    }

    const scored = candidates
      .map((candidate) => scoreTaskCandidate(userMessage, candidate))
      .filter((candidate) => candidate.score >= this.mediumMatchScore)
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
    const strong = scored.filter((candidate) => candidate.score >= this.strongMatchScore);
    if (strong.length > 1) {
      return {
        mode: "ambiguous",
        candidates: strong.map(toRouteCandidate),
        reason: "multiple existing tasks matched strongly",
      };
    }
    if (strong.length === 1) {
      const selected = strong[0]!;
      return selectedTaskResolution(
        selected.task,
        focusTaskId,
        selected.reasons[0] ?? "existing task matched",
      );
    }
    if (scored.length > 1) {
      return {
        mode: "ambiguous",
        candidates: scored.map(toRouteCandidate),
        reason: "multiple existing tasks matched partially",
      };
    }

    return createNew(userMessage, "no existing task matched deterministically");
  }

  async route(input: ApplyGitMemoryTaskRouteInput): Promise<AppliedGitMemoryTaskRoute> {
    const resolution = await this.resolve(input);
    return await this.applyResolution(input, resolution);
  }

  async applyResolution(
    input: ApplyGitMemoryTaskRouteInput,
    resolution: GitMemoryTaskRouteResolution,
  ): Promise<AppliedGitMemoryTaskRoute> {
    if (resolution.mode === "ambiguous") {
      return {
        status: "ambiguous",
        sessionId: input.sessionId,
        candidates: resolution.candidates,
        reason: resolution.reason,
      };
    }

    const conversationRefs = [{ fromSeq: input.fromSeq, toSeq: input.toSeq }];
    if (resolution.mode === "create_new_task") {
      const title = input.title?.trim() || resolution.title;
      const objective = input.objective?.trim() || resolution.objective;
      const createdTask = await this.store.createTaskBranch({
        sessionId: input.sessionId,
        title,
        objective,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        runId: input.runId,
        at: input.at,
        state: {
          status: "open",
          summary: objective,
          completed: [],
          open: [objective],
          blockers: [],
          facts: [],
          next: objective,
        },
      });
      return {
        status: "ready",
        mode: resolution.mode,
        sessionId: input.sessionId,
        taskId: createdTask.taskId,
        branch: createdTask.branch,
        ref: createdTask.ref,
        conversationRefs,
        confidence: resolution.confidence,
        reason: resolution.reason,
        createdTask,
      };
    }

    const selectedTask = await this.store.selectTaskForTurn({
      sessionId: input.sessionId,
      taskId: resolution.taskId,
      reason: routeReasonForMode(resolution.mode),
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      at: input.at,
      runId: input.runId,
      summary: resolution.reason,
    });
    return {
      status: "ready",
      mode: resolution.mode,
      sessionId: input.sessionId,
      taskId: selectedTask.taskId,
      branch: selectedTask.branch,
      ref: selectedTask.ref,
      conversationRefs,
      confidence: resolution.confidence,
      reason: resolution.reason,
      selectedTask,
    };
  }
}

function resolveExplicitTaskId(
  taskIds: GitMemoryTaskId[],
  candidates: GitMemoryTaskRoutingSnapshotTask[],
  focusTaskId: GitMemoryTaskId | undefined,
): GitMemoryTaskRouteResolution {
  const matched = taskIds
    .map((taskId) => candidates.find((candidate) => candidate.taskId === taskId))
    .filter((candidate): candidate is GitMemoryTaskRoutingSnapshotTask => candidate !== undefined);
  if (taskIds.length > 1 || matched.length > 1) {
    return {
      mode: "ambiguous",
      candidates: matched.map((candidate) => candidateToRouteCandidate(candidate, 100, ["explicit task id matched"])),
      reason: "multiple explicit task ids were provided",
    };
  }

  const selected = matched[0];
  if (!selected) {
    return {
      mode: "ambiguous",
      candidates: [],
      reason: `explicit task id not found: ${taskIds[0] ?? "unknown"}`,
    };
  }
  return selectedTaskResolution(selected, focusTaskId, selected.taskId === focusTaskId
    ? "explicit task id matched active focus"
    : "explicit task id matched existing task");
}

function scoreTaskCandidate(userMessage: string, task: GitMemoryTaskRoutingSnapshotTask): ScoredTaskCandidate {
  const scored = scoreGitMemoryTaskSearchDocument({ task }, userMessage);
  const reasons = scored.matchReasons.length > 0 ? scored.matchReasons : ["candidate matched"];

  return {
    ...candidateToRouteCandidate(task, scored.routeScore, reasons),
    task,
  };
}

function selectedTaskResolution(
  task: GitMemoryTaskRoutingSnapshotTask,
  focusTaskId: GitMemoryTaskId | undefined,
  reason: string,
): GitMemoryTaskRouteResolution {
  if (isReopenStatus(task.status)) {
    return {
      mode: "reopen_existing_task",
      taskId: task.taskId,
      branch: task.branch,
      ref: task.ref,
      confidence: "deterministic",
      reason,
    };
  }
  if (task.taskId === focusTaskId) {
    return {
      mode: "continue_active_task",
      taskId: task.taskId,
      branch: task.branch,
      ref: task.ref,
      confidence: "deterministic",
      reason,
    };
  }
  return {
    mode: "switch_to_existing_task",
    taskId: task.taskId,
    branch: task.branch,
    ref: task.ref,
    confidence: "deterministic",
    reason,
  };
}

function candidateToRouteCandidate(
  task: GitMemoryTaskRoutingSnapshotTask,
  score: number,
  reasons: string[],
): GitMemoryTaskRouteCandidate {
  return {
    taskId: task.taskId,
    branch: task.branch,
    ref: task.ref,
    title: task.title,
    status: task.status,
    score,
    reasons,
  };
}

function toRouteCandidate(candidate: GitMemoryTaskRouteCandidate): GitMemoryTaskRouteCandidate {
  return {
    taskId: candidate.taskId,
    branch: candidate.branch,
    ref: candidate.ref,
    title: candidate.title,
    status: candidate.status,
    score: candidate.score,
    reasons: candidate.reasons,
  };
}

function routeReasonForMode(
  mode: Exclude<GitMemoryTaskRouteResolution["mode"], "ambiguous" | "create_new_task">,
): "task_continued" | "task_switched" | "task_reopened" {
  if (mode === "continue_active_task") {
    return "task_continued";
  }
  if (mode === "switch_to_existing_task") {
    return "task_switched";
  }
  return "task_reopened";
}

function extractExplicitTaskIds(message: string): GitMemoryTaskId[] {
  return [...new Set(normalizeText(message).toUpperCase().match(TASK_ID_PATTERN) ?? [])];
}

export function isGitMemoryPureFollowUpMessage(message: string): boolean {
  const normalized = normalizeText(message);
  return [
    "continue",
    "continue it",
    "do it",
    "do the rest",
    "finish",
    "finish it",
    "go on",
    "go ahead",
    "implement it",
    "next",
    "ok",
    "okay",
    "resume",
    "work on it",
    "yes",
  ].includes(normalized);
}

function isReopenStatus(status: string): boolean {
  return status === "done" || status === "abandoned";
}

function createNew(userMessage: string, reason: string): GitMemoryTaskRouteResolution {
  return {
    mode: "create_new_task",
    title: deriveTitleFromMessage(userMessage),
    objective: userMessage.trim() || "Untitled task",
    confidence: "deterministic",
    reason,
  };
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9./_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveTitleFromMessage(message: string, maxLength = 80): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Untitled task";
  }
  const sentence = compact.split(/[.!?]/)[0]?.trim() || compact;
  return sentence.length <= maxLength ? sentence : sentence.slice(0, maxLength).trimEnd();
}
